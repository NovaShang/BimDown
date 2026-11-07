import { describe, it, expect } from 'vitest';
import * as WebIFC from 'web-ifc';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { buildIfc, type IfcSchema } from './exportIfc.ts';
import { ifcGuid } from './ifc/guid.ts';
import { memoryDataSource, sampleProject, fc } from '../test/memoryDataSource.ts';
import { bimdownKeys, countTypes, indexStep, propertyOf, ref, refs, str, type StepEntity } from '../test/ifcStep.ts';

interface Product { type: string; lo: number; hi: number; min: number[]; max: number[]; triangles: number }

async function exportFiles(files: Record<string, string>, schema?: IfcSchema) {
  const project = await loadProject(memoryDataSource({ ...files }));
  const data = await buildIfc(project, 'test', { schema });
  const step = new TextDecoder().decode(data);
  const ents = indexStep(step);
  return { data, step, ents, keys: bimdownKeys(ents) };
}

/** Every exported product with its world bounding box (IFC Z up), keyed `<table>:<id>`. */
async function readBack(data: Uint8Array, keys: Map<number, string>): Promise<Map<string, Product>> {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const model = api.OpenModel(data);
  const out = new Map<string, Product>();
  const onMesh = (mesh: WebIFC.FlatMesh) => {
    const e = api.GetLine(model, mesh.expressID);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let triangles = 0;
    for (let g = 0; g < mesh.geometries.size(); g++) {
      const placed = mesh.geometries.get(g);
      const geom = api.GetGeometry(model, placed.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      triangles += geom.GetIndexDataSize() / 3;
      const m = placed.flatTransformation; // column-major 4x4
      for (let i = 0; i < v.length; i += 6) {
        const [x, y, z] = [v[i], v[i + 1], v[i + 2]];
        const p = [0, 1, 2].map(r => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
      }
      geom.delete();
    }
    // web-ifc hands out Y-up coordinates: world (x, y, z)_ifc = (x, -z, y)_mesh
    const key = keys.get(mesh.expressID) ?? `?:${mesh.expressID}`;
    out.set(key, {
      type: api.GetNameFromTypeCode(e.type),
      lo: min[1], hi: max[1],
      min: [min[0], -max[2], min[1]], max: [max[0], -min[2], max[1]],
      triangles,
    });
  };
  api.StreamAllMeshes(model, onMesh);
  api.StreamAllMeshesWithTypes(model, [WebIFC.IFCSPACE], onMesh); // spaces are skipped by default
  api.CloseModel(model);
  return out;
}

const byKey = (ents: Map<number, StepEntity>, keys: Map<number, string>, key: string) => {
  for (const [id, k] of keys) if (k === key) return ents.get(id)!;
  throw new Error(`no product ${key}`);
};

function expectBox(got: Map<string, Product>, name: string, min: number[], max: number[], digits = 5) {
  const r = got.get(name);
  expect(r, name).toBeDefined();
  expect(r!.triangles, `${name} has a body`).toBeGreaterThan(0);
  for (let k = 0; k < 3; k++) {
    expect(r!.min[k], `${name} min[${k}]`).toBeCloseTo(min[k], digits);
    expect(r!.max[k], `${name} max[${k}]`).toBeCloseTo(max[k], digits);
  }
}

describe('IFC export vertical placement', () => {
  it('places upper-floor elements at their BimDown absolute Z (no double-counted storey)', async () => {
    const { data, keys } = await exportFiles(sampleProject());
    const got = await readBack(data, keys);
    const expectZ = (name: string, lo: number, hi: number) => {
      const r = got.get(name);
      expect(r, name).toBeDefined();
      expect(r!.lo, `${name} bottom`).toBeCloseTo(lo, 6);
      expect(r!.hi, `${name} top`).toBeCloseTo(hi, 6);
    };
    expectZ('structure_slab:ss-1', 3.3, 3.5); // top = 3.6 + base_offset −0.1, 0.2 thick
    expectZ('beam:bm-1', 2.9, 3.5);           // line z 3.5 = beam top, 0.6 deep
    expectZ('duct:du-1', 2.85, 3.15);         // line z 3.0 = centre, 0.3 high
    expectZ('wall:w-1', 3.6, 7.2);            // lv-2 → lv-3
    expectZ('equipment:eq-1', 6.1, 6.6);      // point z 6.1 = base, default 0.5 high
    // plan Y is not mirrored: beam at y = 2, duct at y = 1
    expect((got.get('beam:bm-1')!.min[1] + got.get('beam:bm-1')!.max[1]) / 2).toBeCloseTo(2, 6);
    expect((got.get('duct:du-1')!.min[1] + got.get('duct:du-1')!.max[1]) / 2).toBeCloseTo(1, 6);
    expect(got.get('equipment:eq-1')!.type).toBe('IfcFlowMovingDevice'); // a fan
  });
});

describe('IFC export of MEP runs', () => {
  const files = {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,4\n',
    'lv-1/duct.csv': 'id,number,shape,size_x,size_y,system_type,from,to\n'
      + 'du-1,,rect,0.6,0.4,SA,eq-1:sa,mn-1\n'   // vertical riser
      + 'du-2,,rect,0.6,0.4,SA,mn-1,tm-1:inlet\n' // horizontal
      + 'du-3,,rect,0.3,0.2,SA,,\n',              // sloped
    'lv-1/duct.geojson': fc([
      { type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[1, 1, 2], [1, 1, 3]] } },
      { type: 'Feature', properties: { id: 'du-2' }, geometry: { type: 'LineString', coordinates: [[1, 1, 3], [5, 1, 3]] } },
      { type: 'Feature', properties: { id: 'du-3' }, geometry: { type: 'LineString', coordinates: [[0, 4, 2], [3, 4, 3]] } },
    ]),
    'lv-1/pipe.csv': 'id,number,shape,size_x,system_type\npi-1,,round,0.1,CHWS\n',
    // riser from the ground floor up through lv-2 (absolute Z)
    'lv-1/pipe.geojson': fc([
      { type: 'Feature', properties: { id: 'pi-1' }, geometry: { type: 'LineString', coordinates: [[6, 6, 0.5], [6, 6, 5]] } },
    ]),
    'lv-1/equipment.csv': 'id,number,equipment_type,system_type\neq-1,AHU-1,ahu,SA\n',
    'lv-1/equipment.geojson': fc([
      { type: 'Feature', properties: { id: 'eq-1', size: [2, 1, 2] }, geometry: { type: 'Point', coordinates: [1, 1, 0] } },
    ]),
    'lv-1/connector.csv': 'id,host_id,name,offset_x,offset_y,offset_z,dir_x,dir_y,dir_z,flow_dir\ncn-1,eq-1,sa,0,0,2,0,0,1,out\n',
    'lv-1/terminal.csv': 'id,number,terminal_type,system_type\ntm-1,,supply_air_diffuser,SA\n',
    'lv-1/terminal.geojson': fc([
      { type: 'Feature', properties: { id: 'tm-1', size: [0.6, 0.6, 0.2] }, geometry: { type: 'Point', coordinates: [5, 1, 2.6] } },
    ]),
    'lv-1/mep_node.csv': 'id,system_type\nmn-1,SA\n',
    'lv-1/mep_node.geojson': fc([
      { type: 'Feature', properties: { id: 'mn-1' }, geometry: { type: 'Point', coordinates: [1, 1, 3] } },
    ]),
  };

  it('exports vertical, sloped and round segments with their true 3D bodies', async () => {
    const { data, keys } = await exportFiles(files);
    const got = await readBack(data, keys);
    // Riser section kept upright like the 3D view: width along plan Y for a vertical run.
    expectBox(got, 'duct:du-1', [0.8, 0.7, 2], [1.2, 1.3, 3]);
    expectBox(got, 'duct:du-2', [1, 0.7, 2.8], [5, 1.3, 3.2]);   // 0.6 wide, 0.4 high around z 3
    expect(got.get('duct:du-3')!.lo).toBeLessThan(2);           // sloped: spans 2 → 3 (± section)
    expect(got.get('duct:du-3')!.hi).toBeGreaterThan(3);
    expectBox(got, 'pipe:pi-1', [5.95, 5.95, 0.5], [6.05, 6.05, 5], 2); // round riser (tessellated circle)
    expectBox(got, 'equipment:eq-1', [0, 0.5, 0], [2, 1.5, 2]);
    expectBox(got, 'terminal:tm-1', [4.7, 0.7, 2.6], [5.3, 1.3, 2.8]);
    // Elbow: one stub per leg (riser down, run along +X), closing the corner.
    expectBox(got, 'mep_node:mn-1', [0.7, 0.7, 2.7], [1.3, 1.3, 3.3]);
    expect(Object.fromEntries([...got].map(([n, r]) => [n, r.type]))).toEqual({
      'duct:du-1': 'IfcFlowSegment', 'duct:du-2': 'IfcFlowSegment', 'duct:du-3': 'IfcFlowSegment',
      'pipe:pi-1': 'IfcFlowSegment',
      'equipment:eq-1': 'IfcEnergyConversionDevice',
      'terminal:tm-1': 'IfcFlowTerminal',
      'mep_node:mn-1': 'IfcFlowFitting',
    });
  });

  it('writes ports, port connections and systems', async () => {
    const { ents, keys } = await exportFiles(files);
    const types = countTypes(ents);
    // 4 segments × 2 ends, the AHU's declared port, the elbow's 2 legs, the diffuser's derived port.
    expect(types.IFCDISTRIBUTIONPORT).toBe(12);
    expect(types.IFCRELCONNECTSPORTTOELEMENT).toBe(12);
    expect(types.IFCRELCONNECTSPORTS).toBe(4); // du-1 from/to, du-2 from/to
    const conns = [...ents.values()].filter(e => e.type === 'IFCRELCONNECTSPORTS');
    const hostOf = (port: number) => {
      const rel = [...ents.values()].find(e => e.type === 'IFCRELCONNECTSPORTTOELEMENT' && ref(e.args[4]) === port)!;
      return keys.get(ref(rel.args[5]));
    };
    const pairs = conns.map(c => [hostOf(ref(c.args[4])), hostOf(ref(c.args[5]))].join(' → ')).sort();
    // Relating port = upstream: AHU → riser → elbow → run → diffuser.
    expect(pairs).toEqual([
      'duct:du-1 → mep_node:mn-1', 'duct:du-2 → terminal:tm-1',
      'equipment:eq-1 → duct:du-1', 'mep_node:mn-1 → duct:du-2',
    ]);
    // The AHU end of du-1 lands on the declared `sa` port, not a derived one.
    const ahuPort = [...ents.values()].find(e => e.type === 'IFCDISTRIBUTIONPORT' && str(e.args[2]) === 'sa');
    expect(ahuPort?.args[7]).toBe('.SOURCE.');
    // Systems: SA and CHWS with their members.
    const systems = [...ents.values()].filter(e => e.type === 'IFCSYSTEM').map(e => str(e.args[2])).sort();
    expect(systems).toEqual(['CHWS', 'SA']);
    const groups = [...ents.values()].filter(e => e.type === 'IFCRELASSIGNSTOGROUP')
      .map(e => [str(ents.get(ref(e.args[6]))!.args[2]), refs(e.args[4]).map(id => keys.get(id)).sort()]);
    expect(Object.fromEntries(groups)).toEqual({
      CHWS: ['pipe:pi-1'],
      SA: ['duct:du-1', 'duct:du-2', 'duct:du-3', 'equipment:eq-1', 'mep_node:mn-1', 'terminal:tm-1'],
    });
    // Round pipe → circle profile; the passive node reads as an elbow.
    expect(propertyOf(ents, [...keys].find(([, k]) => k === 'mep_node:mn-1')![0], 'BimDown', 'Id')).toBe("IFCIDENTIFIER('mn-1')");
    expect(byKey(ents, keys, 'mep_node:mn-1').args[4]).toBe("'elbow'");
  });

  it('IFC4 uses the specific MEP entities', async () => {
    const { step, ents } = await exportFiles(files, 'IFC4');
    expect(step).toContain("FILE_SCHEMA(('IFC4'))");
    const types = countTypes(ents);
    expect(types.IFCDUCTSEGMENT).toBe(3);
    expect(types.IFCPIPESEGMENT).toBe(1);
    expect(types.IFCUNITARYEQUIPMENT).toBe(1);
    expect(types.IFCAIRTERMINAL).toBe(1);
    expect(types.IFCDUCTFITTING).toBe(1);
    expect(types.IFCDISTRIBUTIONSYSTEM).toBe(2);
    expect(types.IFCRELNESTS).toBeGreaterThan(0);
    expect(types.IFCRELCONNECTSPORTS).toBe(4);
  });
});

/** One room (two walls bounding it from outside, a partition, a door and a window) plus a sloped-roof level. */
const room = {
  'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
  'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\n',
  'lv-1/wall.csv': 'id,number,thickness,material\nw-1,EW,0.2,brick\nw-2,EW,0.2,brick\nw-3,EW,0.2,brick\nw-4,EW,0.2,brick\nw-5,IW,0.1,gypsum\n',
  'lv-1/wall.geojson': fc([
    { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [8, 0]] } },
    { type: 'Feature', properties: { id: 'w-2' }, geometry: { type: 'LineString', coordinates: [[8, 0], [8, 5]] } },
    { type: 'Feature', properties: { id: 'w-3' }, geometry: { type: 'LineString', coordinates: [[8, 5], [0, 5]] } },
    { type: 'Feature', properties: { id: 'w-4' }, geometry: { type: 'LineString', coordinates: [[0, 5], [0, 0]] } },
    { type: 'Feature', properties: { id: 'w-5' }, geometry: { type: 'LineString', coordinates: [[5, 0], [5, 5]] } },
  ]),
  'lv-1/door.csv': 'id,number,host_id,position,width,height,material,operation\nd-1,D1,w-1,2,1.0,2.1,wood,single_swing\n',
  'lv-1/window.csv': 'id,number,host_id,position,width,height,base_offset,material,operation\nwn-1,W1,w-4,2.5,1.2,1.5,0.9,aluminum,casement\n',
  'lv-1/opening.csv': 'id,number,host_id,position,width,height,shape,base_offset\nop-1,O1,w-5,2.5,0.8,2.0,rect,0\n',
  'lv-1/space.csv': 'id,number,name,x,y\nsp-1,101,Living,2.5,2.5\nsp-2,102,Bed,6.5,2.5\n',
  'lv-1/slab.csv': 'id,number,function,thickness,material\nsl-1,FL,floor,0.2,concrete\n',
  'lv-1/slab.geojson': fc([{ type: 'Feature', properties: { id: 'sl-1' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [8, 0], [8, 5], [0, 5], [0, 0]]] } }]),
  'lv-1/stair.csv': 'id,number,width,step_count\nst-1,S1,1.0,10\n',
  'lv-1/stair.geojson': fc([{ type: 'Feature', properties: { id: 'st-1' }, geometry: { type: 'LineString', coordinates: [[1, 4, 0], [4, 4, 3]] } }]),
  'lv-1/structure_column.csv': 'id,number,shape,size_x,size_y,flange,web,material,top_level_id\nsc-1,C1,i_shape,0.2,0.4,0.02,0.01,steel,lv-2\n',
  'lv-1/structure_column.geojson': fc([{ type: 'Feature', properties: { id: 'sc-1', rotation: 90 }, geometry: { type: 'Point', coordinates: [6, 4] } }]),
  'lv-1/foundation.csv': 'id,number,material,thickness\nf-1,F1,concrete,0.5\nf-2,F2,concrete,0.4\n',
  'lv-1/foundation.geojson': fc([
    { type: 'Feature', properties: { id: 'f-1', size: [1.2, 1.2] }, geometry: { type: 'Point', coordinates: [6, 4] } },
    { type: 'Feature', properties: { id: 'f-2' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } },
  ]),
  'lv-2/roof.csv': 'id,number,roof_type,slope,thickness,material\nro-1,R1,hip,30,0.2,concrete\n',
  'lv-2/roof.geojson': fc([{ type: 'Feature', properties: { id: 'ro-1' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [8, 0], [8, 5], [0, 5], [0, 0]]] } }]),
  'lv-2/brace.csv': 'id,number,shape,size_x,size_y,material\nbr-1,X1,rect,0.1,0.1,steel\n',
  'lv-2/brace.geojson': fc([{ type: 'Feature', properties: { id: 'br-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3], [4, 0, 6]] } }]),
};

describe('IFC export of the building', () => {
  it('voids walls for doors / windows / openings and fills them', async () => {
    const { ents, keys } = await exportFiles(room);
    const types = countTypes(ents);
    expect(types.IFCOPENINGELEMENT).toBe(3);
    expect(types.IFCRELVOIDSELEMENT).toBe(3);
    expect(types.IFCRELFILLSELEMENT).toBe(2);
    const voids = [...ents.values()].filter(e => e.type === 'IFCRELVOIDSELEMENT').map(e => keys.get(ref(e.args[4]))).sort();
    expect(voids).toEqual(['wall:w-1', 'wall:w-4', 'wall:w-5']);
    // Opening body = the door's size; the door fills it.
    const fill = [...ents.values()].find(e => e.type === 'IFCRELFILLSELEMENT' && keys.get(ref(e.args[5])) === 'door:d-1')!;
    const opening = ents.get(ref(fill.args[4]))!;
    const shape = ents.get(ref(opening.args[6]))!;
    const body = ents.get(refs(shape.args[2])[0])!;
    const solid = ents.get(refs(body.args[3])[0])!;
    const profile = ents.get(ref(solid.args[0]))!;
    expect(profile.type).toBe('IFCRECTANGLEPROFILEDEF');
    expect(Number(profile.args[3])).toBeCloseTo(1.0, 9);
    expect(Number(profile.args[4])).toBeCloseTo(2.1, 9);
    const door = byKey(ents, keys, 'door:d-1');
    expect(door.args.slice(8)).toEqual(['2.1', '1.']);
    expect(str(door.args[2])).toBe('D1');
    expect(str(door.args[7])).toBe('d-1');
  });

  it('exports rooms with their derived outline, quantities and space boundaries', async () => {
    const { data, ents, keys } = await exportFiles(room);
    const got = await readBack(data, keys);
    expectBox(got, 'space:sp-1', [0, 0, 0], [5, 5, 3]);
    expectBox(got, 'space:sp-2', [5, 0, 0], [8, 5, 3]);
    const sp1 = byKey(ents, keys, 'space:sp-1');
    expect(str(sp1.args[2])).toBe('101');
    expect(str(sp1.args[7])).toBe('Living');
    expect(Number(propertyOf(ents, sp1.id, 'Qto_SpaceBaseQuantities', 'GrossFloorArea'))).toBeCloseTo(25, 9);
    // Net: inside faces of the walls (0.1 / 0.05 half thickness).
    expect(Number(propertyOf(ents, sp1.id, 'Qto_SpaceBaseQuantities', 'NetFloorArea'))).toBeCloseTo(4.85 * 4.8, 6);
    expect(Number(propertyOf(ents, sp1.id, 'Qto_SpaceBaseQuantities', 'Height'))).toBeCloseTo(3, 9);
    // sp-1: 4 wall edges (w-1 part, w-5, w-3 part, w-4) + door + window + opening-free partition + floor + hip roof above.
    const boundaries = [...ents.values()].filter(e => e.type === 'IFCRELSPACEBOUNDARY' && ref(e.args[4]) === sp1.id);
    const related = boundaries.map(b => keys.get(ref(b.args[5]))).sort();
    expect(related).toEqual(['door:d-1', 'roof:ro-1', 'slab:sl-1', 'wall:w-1', 'wall:w-3', 'wall:w-4', 'wall:w-5', 'window:wn-1']);
    const ext = (k: string) => boundaries.find(b => keys.get(ref(b.args[5])) === k)!.args[8];
    expect(ext('wall:w-1')).toBe('.EXTERNAL.');
    expect(ext('wall:w-5')).toBe('.INTERNAL.');
    expect(ext('window:wn-1')).toBe('.EXTERNAL.');
    expect(propertyOf(ents, byKey(ents, keys, 'wall:w-5').id, 'Pset_WallCommon', 'IsExternal')).toBe('IFCBOOLEAN(.F.)');
    expect(propertyOf(ents, byKey(ents, keys, 'wall:w-1').id, 'Pset_WallCommon', 'IsExternal')).toBe('IFCBOOLEAN(.T.)');
    expect(propertyOf(ents, byKey(ents, keys, 'door:d-1').id, 'Pset_DoorCommon', 'IsExternal')).toBe('IFCBOOLEAN(.T.)');
  });

  it('builds sloped roofs, stepped stairs, real sections and foundations', async () => {
    const { data, ents, keys } = await exportFiles(room);
    const got = await readBack(data, keys);
    // Hip roof: 5 m span, 30° → ridge 2.5·tan30 above the 0.2 m thick eave.
    expectBox(got, 'roof:ro-1', [0, 0, 3], [8, 5, 3.2 + 2.5 * Math.tan(Math.PI / 6)], 4);
    expect(byKey(ents, keys, 'roof:ro-1').args[8]).toBe('.HIP_ROOF.');
    // Stair: one stepped flight from 0 to 3 m inside an IfcStair.
    const flight = [...got].find(([, p]) => p.type === 'IfcStairFlight')![1];
    expect(flight.min[2]).toBeCloseTo(0, 6);
    expect(flight.max[2]).toBeCloseTo(3, 6);
    expect(flight.triangles).toBeGreaterThan(40); // 10 risers + treads, not a box
    // I-shape column rotated 90° CCW: 0.2 flange now along plan Y... depth 0.4 along X.
    expectBox(got, 'structure_column:sc-1', [5.8, 3.9, 0], [6.2, 4.1, 3]);
    const col = byKey(ents, keys, 'structure_column:sc-1');
    const colSolid = ents.get(refs(ents.get(refs(ents.get(ref(col.args[6]))!.args[2])[0])!.args[3])[0])!;
    expect(ents.get(ref(colSolid.args[0]))!.type).toBe('IFCISHAPEPROFILEDEF');
    // Brace: an IfcMember along its sloped line (top of section on the line).
    expect(got.get('brace:br-1')!.type).toBe('IfcMember');
    expect(got.get('brace:br-1')!.max[2]).toBeCloseTo(6, 6);
    expect(got.get('brace:br-1')!.min[2]).toBeLessThan(3);
    // Foundations: pad footing and raft (base slab) below the level.
    expect(byKey(ents, keys, 'foundation:f-1').type).toBe('IFCFOOTING');
    expect(byKey(ents, keys, 'foundation:f-1').args[8]).toBe('.PAD_FOOTING.');
    expect(byKey(ents, keys, 'foundation:f-2').args[8]).toBe('.BASESLAB.');
    expectBox(got, 'foundation:f-1', [5.4, 3.4, -0.5], [6.6, 4.6, 0]);
    // Materials: a layer set on walls, a plain material elsewhere.
    expect(countTypes(ents).IFCMATERIALLAYERSETUSAGE).toBeGreaterThan(0);
    expect([...ents.values()].filter(e => e.type === 'IFCMATERIAL').map(e => str(e.args[0])).sort())
      .toEqual(['brick', 'concrete', 'gypsum', 'steel', 'wood', 'aluminum'].sort());
  });

  it('writes type layer sets, foundation kinds and type U-values', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\n',
      'global/wall_type.csv': 'id,name,description,material,thickness\nwt-1,Brick cavity,,brick,\n',
      'global/door_type.csv': 'id,name,description,material,u_value,shgc,vt,width,height,operation,frame_width\ndt-1,Insulated door,,wood,1.4,,,0.9,2.1,single_swing,\n',
      'global/type_layer.csv': 'id,type_id,seq,function,material,thickness,conductivity,name\n'
        + 'tl-1,wt-1,1,finish,brick,0.1,0.8,Facing brick\ntl-2,wt-1,2,insulation,insulation,0.08,0.035,Mineral wool\ntl-3,wt-1,3,core,concrete,0.15,1.8,Block\n',
      'lv-1/wall.csv': 'id,number,type_id,thickness\nw-1,W1,wt-1,\n',
      'lv-1/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [6, 0]] } }]),
      'lv-1/door.csv': 'id,number,host_id,position,type_id\nd-1,D1,w-1,2,dt-1\n',
      'lv-1/foundation.csv': 'id,number,kind,material,thickness,width,length\nf-1,P1,pile,concrete,12,0.6,\nf-2,PC1,pile_cap,concrete,1.0,2.0,2.0\nf-3,SF1,strip,concrete,0.5,0.8,\n',
      'lv-1/foundation.geojson': fc([
        { type: 'Feature', properties: { id: 'f-1' }, geometry: { type: 'Point', coordinates: [1, 1] } },
        { type: 'Feature', properties: { id: 'f-2' }, geometry: { type: 'Point', coordinates: [4, 4] } },
        { type: 'Feature', properties: { id: 'f-3' }, geometry: { type: 'LineString', coordinates: [[0, 0], [6, 0]] } },
      ]),
    };
    for (const schema of ['IFC2X3', 'IFC4'] as const) {
      const { ents, keys } = await exportFiles(files, schema);
      // Wall: the type's three layers, exterior (seq 1, left of start → end) first, stacked NEGATIVE from +t/2.
      const wall = byKey(ents, keys, 'wall:w-1');
      const rel = [...ents.values()].find(e => e.type === 'IFCRELASSOCIATESMATERIAL' && refs(e.args[4]).includes(wall.id))!;
      const usage = ents.get(ref(rel.args[5]))!;
      expect(usage.type).toBe('IFCMATERIALLAYERSETUSAGE');
      expect(usage.args[2]).toBe('.NEGATIVE.');
      expect(Number(usage.args[3])).toBeCloseTo(0.165, 9);
      const set = ents.get(ref(usage.args[0]))!;
      expect(str(set.args[1])).toBe('Brick cavity');
      const layers = refs(set.args[0]).map(id => ents.get(id)!);
      expect(layers.map(l => Number(l.args[1]))).toEqual([0.1, 0.08, 0.15]);
      expect(layers.map(l => str(ents.get(ref(l.args[0]))!.args[0]))).toEqual(['brick', 'insulation', 'concrete']);
      // Door: the type's U-value
      expect(propertyOf(ents, byKey(ents, keys, 'door:d-1').id, 'Pset_DoorCommon', 'ThermalTransmittance')).toBe('IFCTHERMALTRANSMITTANCEMEASURE(1.4)');
      // Foundations by kind
      expect(byKey(ents, keys, 'foundation:f-1').type).toBe('IFCPILE');
      expect(byKey(ents, keys, 'foundation:f-2').args[8]).toBe('.PILE_CAP.');
      expect(byKey(ents, keys, 'foundation:f-3').args[8]).toBe('.STRIP_FOOTING.');
    }
  });

  it('assigns global (multi-storey) elements to their base storey', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-3,3,L3,6\n',
      'global/structure_column.csv': 'id,number,base_level_id,top_level_id,shape,size_x,size_y\nsc-g,CG,lv-2,lv-3,rect,0.4,0.4\n',
      'global/structure_column.geojson': fc([{ type: 'Feature', properties: { id: 'sc-g' }, geometry: { type: 'Point', coordinates: [1, 1] } }]),
      'global/beam.csv': 'id,number,shape,size_x,size_y\nbm-g,BG,rect,0.3,0.5\n',
      'global/beam.geojson': fc([{ type: 'Feature', properties: { id: 'bm-g' }, geometry: { type: 'LineString', coordinates: [[0, 0, 6], [5, 0, 6]] } }]),
    };
    const { data, ents, keys } = await exportFiles(files);
    const got = await readBack(data, keys);
    expectBox(got, 'structure_column:sc-g', [0.8, 0.8, 3], [1.2, 1.2, 6]);
    expectBox(got, 'beam:bm-g', [0, -0.15, 5.5], [5, 0.15, 6]);
    const storeyOf = (key: string) => {
      const id = byKey(ents, keys, key).id;
      const rel = [...ents.values()].find(e => e.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' && refs(e.args[4]).includes(id))!;
      return str(ents.get(ref(rel.args[5]))!.args[2]);
    };
    expect(storeyOf('structure_column:sc-g')).toBe('L2');
    expect(storeyOf('beam:bm-g')).toBe('L3'); // beam line (its top) on L3, like level-folder beams
  });

  it('aggregates multi-run stairs: flights per stair_run plus the landing', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.5\n',
      'lv-2/stair.csv': 'id,number,width,step_count,stair_type\nst-1,S1,1.0,20,half_turn\n',
      'lv-2/stair.geojson': fc([{ type: 'Feature', properties: { id: 'st-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3.5], [0, 1, 7]] } }]),
      'lv-2/stair_run.csv': 'id,number,host_id,width,step_count\nsr-1,A,st-1,1.0,10\nsr-2,B,st-1,1.0,10\n',
      'lv-2/stair_run.geojson': fc([
        { type: 'Feature', properties: { id: 'sr-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3.5], [2.5, 0, 5.25]] } },
        { type: 'Feature', properties: { id: 'sr-2' }, geometry: { type: 'LineString', coordinates: [[2.5, 1, 5.25], [0, 1, 7]] } },
      ]),
      'lv-2/stair_landing.csv': 'id,number,host_id,thickness\nsl-1,L,st-1,0.15\n',
      'lv-2/stair_landing.geojson': fc([{ type: 'Feature', properties: { id: 'sl-1', base_offset: 1.75 }, geometry: { type: 'Polygon', coordinates: [[[2.5, -0.5], [3.5, -0.5], [3.5, 1.5], [2.5, 1.5], [2.5, -0.5]]] } }]),
    };
    const { data, ents, keys } = await exportFiles(files);
    const got = await readBack(data, keys);
    // stair_run Z comes from its GeoJSON coordinates (absolute), like any spatial line.
    expectBox(got, 'stair_run:sr-1', [0, -0.5, 3.5], [2.5, 0.5, 5.25]);
    expectBox(got, 'stair_run:sr-2', [0, 0.5, 5.25], [2.5, 1.5, 7]);
    expectBox(got, 'stair_landing:sl-1', [2.5, -0.5, 5.1], [3.5, 1.5, 5.25]);
    const stair = byKey(ents, keys, 'stair:st-1');
    const agg = [...ents.values()].find(e => e.type === 'IFCRELAGGREGATES' && ref(e.args[4]) === stair.id)!;
    expect(refs(agg.args[5]).map(id => keys.get(id)).sort()).toEqual(['stair_landing:sl-1', 'stair_run:sr-1', 'stair_run:sr-2']);
    expect(stair.args[8]).toBe('.HALF_TURN_STAIR.');
  });

  it('writes the structural grid as an IfcGrid with two axis families', async () => {
    const project = await loadProject(memoryDataSource({ ...room }));
    const grids = [
      { id: 'g1', number: '1', x1: 0, y1: -1, x2: 0, y2: 6 }, { id: 'g2', number: '2', x1: 5, y1: -1, x2: 5, y2: 6 },
      { id: 'ga', number: 'A', x1: -1, y1: 0, x2: 9, y2: 0 },
    ];
    const ents = indexStep(new TextDecoder().decode(await buildIfc(project, 'grid', { grids })));
    const grid = [...ents.values()].filter(e => e.type === 'IFCGRID');
    expect(grid).toHaveLength(1);
    const tags = (list: string) => refs(list).map(id => str(ents.get(id)!.args[0])).sort();
    expect([tags(grid[0].args[7]), tags(grid[0].args[8])]).toEqual([['1', '2'], ['A']]);
  });

  it('keeps GlobalIds stable across exports', async () => {
    const a = await exportFiles(room);
    const b = await exportFiles(room);
    const guids = (x: typeof a) => [...x.keys].map(([id, k]) => `${k}=${str(x.ents.get(id)!.args[0])}`).sort();
    expect(guids(a)).toEqual(guids(b));
    const all = [...a.ents.values()].filter(e => e.args[0]?.startsWith("'") && e.args[1]?.startsWith('#') && /^'[0-9A-Za-z_$]{22}'$/.test(e.args[0]));
    expect(new Set(all.map(e => e.args[0])).size).toBe(all.length);
  });
});

describe('IFC GUIDs', () => {
  it('are 22 IFC base64 chars, deterministic, first char 0..3', () => {
    const g = ifcGuid('lv-1/wall/w-1');
    expect(g).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(ifcGuid('lv-1/wall/w-1')).toBe(g);
    expect(ifcGuid('lv-2/wall/w-1')).not.toBe(g);
  });
});
