import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import type { CanonicalElement, SpatialLineElement } from '../model/elements.ts';
import { autoVent } from './autoVent.ts';
import { checkDocument } from './mepModel.ts';

const pt = (id: string, x: number, y: number, z: number, size?: number[]) =>
  ({ type: 'Feature', properties: size ? { id, size } : { id }, geometry: { type: 'Point', coordinates: [x, y, z] } });
const ln = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** A WC and a basin side by side, a basin far away, each draining to a SAN main at y = 3; a vent stack at (5, 4). */
function toilets(withStack = true) {
  const f = files();
  f['lv-1/terminal.csv'] = 'id,number,system_type,terminal_type\ntm-1,,SAN,water_closet\ntm-2,,SAN,lavatory\ntm-3,,SAN,lavatory\n';
  f['lv-1/terminal.geojson'] = fc([pt('tm-1', 2, 1, 0, [0.4, 0.7, 0.8]), pt('tm-2', 3.5, 1, 0, [0.55, 0.45, 0.85]), pt('tm-3', 10, 1, 0, [0.55, 0.45, 0.85])]);
  f['lv-1/connector.csv'] = 'id,host_id,name,offset_x,offset_y,offset_z,dir_x,dir_y,dir_z,shape,size_w,size_h,system_type,flow_dir,domain\n'
    + 'cn-1,tm-1,drain,0,0,0,0,0,-1,round,0.1,,SAN,out,piping\n'
    + 'cn-2,tm-2,drain,0,0,0,0,0,-1,round,0.04,,SAN,out,piping\n'
    + 'cn-3,tm-3,drain,0,0,0,0,0,-1,round,0.04,,SAN,out,piping\n';
  f['lv-1/pipe.csv'] = 'id,shape,size_x,system_type,from,to\n'
    + 'pi-1,round,0.1,SAN,tm-1:drain,mn-1\npi-2,round,0.05,SAN,tm-2:drain,mn-2\npi-3,round,0.05,SAN,tm-3:drain,mn-3\n'
    + 'pi-4,round,0.1,SAN,mn-1,mn-2\npi-5,round,0.1,SAN,mn-2,mn-3\npi-6,round,0.1,SAN,mn-3,\n'
    + (withStack ? 'pi-9,round,0.1,VENT,,\n' : '');
  f['lv-1/pipe.geojson'] = fc([
    ln('pi-1', [2, 1, 0], [2, 3, -0.04]), ln('pi-2', [3.5, 1, 0], [3.5, 3, -0.04]), ln('pi-3', [10, 1, 0], [10, 3, -0.04]),
    ln('pi-4', [2, 3, -0.04], [3.5, 3, -0.07]), ln('pi-5', [3.5, 3, -0.07], [10, 3, -0.2]), ln('pi-6', [10, 3, -0.2], [12, 3, -0.24]),
    ...(withStack ? [ln('pi-9', [5, 4, -0.5], [5, 4, 3.5])] : []),
  ]);
  f['lv-1/mep_node.csv'] = 'id,system_type,kind\nmn-1,SAN,\nmn-2,SAN,\nmn-3,SAN,\n';
  f['lv-1/mep_node.geojson'] = fc([pt('mn-1', 2, 3, -0.04), pt('mn-2', 3.5, 3, -0.07), pt('mn-3', 10, 3, -0.2)]);
  return f;
}

const pipes = (els: Iterable<CanonicalElement>) => [...els].filter(e => e.tableName === 'pipe') as SpatialLineElement[];

describe('automatic branch venting', () => {
  it('vents each fixture group into the stack: a tee on the drain, a riser, a branch at rim + 150 mm, a tee on the stack', async () => {
    const { state } = await load(toilets());
    const els = state.document!.elements;
    const before = checkDocument(els).filter(p => p.severity === 'warning').map(p => `${p.code}:${p.id}`).sort();
    const r = autoVent(els, { levelId: 'lv-1' });
    expect(r.skipped).toEqual([]);
    // WC + basin share a branch; the far basin has its own; both at 0.85 + 0.15
    expect(r.groups.map(g => [g.fixtures.slice().sort(), g.height])).toEqual([[['tm-1', 'tm-2'], 1], [['tm-3'], 1]]);
    const live = new Map(els);
    for (const e of r.patch) live.set(e.id, e);
    const vents = pipes(live.values()).filter(p => p.attrs.system_type === 'VENT');
    // 3 risers, branch tm-1→tm-2 (one leg), tm-2→stack (two legs), tm-3→stack (two legs), stack split in two
    const risers = vents.filter(p => p.start.x === p.end.x && p.start.y === p.end.y && p.id !== 'pi-9' && !(p.start.x === 5 && p.start.y === 4));
    expect(risers.map(p => p.attrs.size_x).sort()).toEqual(['0.04', '0.04', '0.05']);
    // On the drain, ≥ 300 mm from the fixture and clear of its body (WC 0.7 deep: 0.35 + 0.1)
    expect(risers.map(p => [p.start.x, Math.round(p.start.y * 1000) / 1000, Math.round(p.startZ * 1e5) / 1e5, p.endZ]).sort((a, b) => a[0] - b[0]))
      .toEqual([[2, 1.45, -0.009, 1], [3.5, 1.325, -0.0065, 1], [10, 1.325, -0.0065, 1]]);
    const stack = vents.filter(p => p.start.x === 5 && p.start.y === 4);
    expect(stack.map(p => [p.startZ, p.endZ]).sort()).toEqual([[-0.5, 1], [1, 3.5]]);
    // Drains were split with a tee, keeping their fall
    const drain1 = pipes(live.values()).filter(p => p.attrs.system_type === 'SAN' && p.start.x === 2 && p.end.x === 2);
    expect(drain1).toHaveLength(2);
    expect(drain1.map(p => p.endZ).sort((a, b) => a - b)[0]).toBeCloseTo(-0.04, 6);
    // Nothing new to complain about (the stack top stays the open end it was)
    const after = checkDocument(live).filter(p => p.severity === 'warning').map(p => `${p.code}:${p.id}`).sort();
    expect(after.filter(w => !before.includes(w))).toEqual([]);
    // Running it again finds every fixture vented
    expect(autoVent(live, { levelId: 'lv-1' }).skipped.map(s => s.reason)).toEqual(['vented', 'vented', 'vented']);
  });

  it('reports fixtures with no drain or no stack instead of guessing', async () => {
    const f = toilets(false);
    const { state } = await load(f);
    const r = autoVent(state.document!.elements, { levelId: 'lv-1' });
    expect(r.patch).toEqual([]);
    expect(r.skipped.map(s => s.reason)).toEqual(['no_stack', 'no_stack', 'no_stack']);
    const g = toilets();
    g['lv-1/terminal.csv'] += 'tm-4,,,sink\n';
    g['lv-1/terminal.geojson'] = fc([pt('tm-1', 2, 1, 0, [0.4, 0.7, 0.8]), pt('tm-2', 3.5, 1, 0, [0.55, 0.45, 0.85]), pt('tm-3', 10, 1, 0, [0.55, 0.45, 0.85]), pt('tm-4', 8, 8, 0)]);
    const { state: s2 } = await load(g);
    expect(autoVent(s2.document!.elements, { levelId: 'lv-1' }).skipped).toEqual([{ id: 'tm-4', reason: 'no_drain' }]);
  });
});
