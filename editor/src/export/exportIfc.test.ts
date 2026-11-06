import { describe, it, expect } from 'vitest';
import * as WebIFC from 'web-ifc';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { buildIfc } from './exportIfc.ts';
import { memoryDataSource, sampleProject, fc } from '../test/memoryDataSource.ts';

interface Product { type: string; lo: number; hi: number; min: number[]; max: number[]; triangles: number }

/** Every exported product with its world bounding box (IFC Z up), from web-ifc's tessellation. */
async function readBack(data: Uint8Array): Promise<Map<string, Product>> {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const model = api.OpenModel(data);
  const out = new Map<string, Product>();
  api.StreamAllMeshes(model, (mesh) => {
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
    out.set(e.Name.value, {
      type: api.GetNameFromTypeCode(e.type),
      lo: min[1], hi: max[1],
      min: [min[0], -max[2], min[1]], max: [max[0], -min[2], max[1]],
      triangles,
    });
  });
  api.CloseModel(model);
  return out;
}

describe('IFC export vertical placement', () => {
  it('places upper-floor elements at their BimDown absolute Z (no double-counted storey)', async () => {
    const project = await loadProject(memoryDataSource(sampleProject()));
    const got = await readBack(await buildIfc(project));
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
    const project = await loadProject(memoryDataSource({ ...files }));
    const got = await readBack(await buildIfc(project));
    const box = (name: string) => {
      const r = got.get(name);
      expect(r, name).toBeDefined();
      expect(r!.triangles, `${name} has a body`).toBeGreaterThan(0);
      return r!;
    };
    const expectBox = (name: string, min: number[], max: number[], digits = 5) => {
      const r = box(name);
      for (let k = 0; k < 3; k++) {
        expect(r.min[k], `${name} min[${k}]`).toBeCloseTo(min[k], digits);
        expect(r.max[k], `${name} max[${k}]`).toBeCloseTo(max[k], digits);
      }
    };
    expectBox('duct:du-1', [0.7, 0.8, 2], [1.3, 1.2, 3]);       // riser: 0.6 x 0.4 section, 2 → 3
    expectBox('duct:du-2', [1, 0.7, 2.8], [5, 1.3, 3.2]);       // 0.6 wide, 0.4 high around z 3
    expect(box('duct:du-3').lo).toBeLessThan(2);                // sloped: spans 2 → 3 (± section)
    expect(box('duct:du-3').hi).toBeGreaterThan(3);
    expectBox('pipe:pi-1', [5.95, 5.95, 0.5], [6.05, 6.05, 5], 2); // round riser (tessellated circle)
    expectBox('equipment:eq-1', [0, 0.5, 0], [2, 1.5, 2]);
    expectBox('terminal:tm-1', [4.7, 0.7, 2.6], [5.3, 1.3, 2.8]);
    expectBox('mep_node:mn-1', [0.7, 0.7, 2.7], [1.3, 1.3, 3.3]); // largest connected section
    expect(Object.fromEntries([...got].map(([n, r]) => [n, r.type]))).toEqual({
      'duct:du-1': 'IfcFlowSegment', 'duct:du-2': 'IfcFlowSegment', 'duct:du-3': 'IfcFlowSegment',
      'pipe:pi-1': 'IfcFlowSegment',
      'equipment:eq-1': 'IfcEnergyConversionDevice',
      'terminal:tm-1': 'IfcFlowTerminal',
      'mep_node:mn-1': 'IfcFlowFitting',
    });
  });
});
