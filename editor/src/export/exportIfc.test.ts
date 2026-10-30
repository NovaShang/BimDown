import { describe, it, expect } from 'vitest';
import * as WebIFC from 'web-ifc';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { buildIfc } from './exportIfc.ts';
import { memoryDataSource, sampleProject } from '../test/memoryDataSource.ts';

/** World Z range and plan centre of each exported product, read back from the
 *  STEP data: storey placement + swept-solid position + depth. */
async function readBack(data: Uint8Array) {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const model = api.OpenModel(data);
  const line = (id: number) => api.GetLine(model, id, true);
  const out = new Map<string, { lo: number; hi: number; x: number; y: number }>();
  const ids = api.GetAllLines(model);
  for (let i = 0; i < ids.size(); i++) {
    const e = line(ids.get(i));
    if (!e?.Representation || !e.ObjectPlacement || e.type === WebIFC.IFCBUILDINGSTOREY) continue;
    const storeyZ = e.ObjectPlacement.PlacementRelTo.RelativePlacement.Location.Coordinates[2].value;
    const elZ = e.ObjectPlacement.RelativePlacement.Location.Coordinates[2].value;
    const solid = e.Representation.Representations[0].Items[0];
    const [x, y, z] = solid.Position.Location.Coordinates.map((c: { value: number }) => c.value);
    const lo = storeyZ + elZ + z;
    out.set(e.Name.value, { lo, hi: lo + solid.Depth.value, x, y });
  }
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
    // plan Y is not mirrored: beam at y = 2, duct at y = 1
    expect(got.get('beam:bm-1')!.y).toBeCloseTo(2, 6);
    expect(got.get('duct:du-1')!.y).toBeCloseTo(1, 6);
  });
});
