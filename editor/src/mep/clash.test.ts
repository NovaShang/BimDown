import { describe, it, expect, vi } from 'vitest';
import '../elements/registerAll.ts';
import { createHarness } from '../test/authorHarness.ts';
import { memoryDataSource, sampleProject, fc } from '../test/memoryDataSource.ts';
import { loadProject } from '../utils/loader.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import type { EditorState } from '../state/editorTypes.ts';
import { detectClashes, type ClashCurveIn } from './clash.ts';
import { buildClashModel } from './clashModel.ts';
import { clashSectionBox, zoomPlanTo } from './clashView.tsx';

const clashesOf = (s: EditorState, opts = {}) => detectClashes(buildClashModel(s.document!.elements, { project: s.project, levelId: s.currentLevel }), opts);
const pipe = (id: string, a: [number, number, number], b: [number, number, number], d: number, system: string): ClashCurveIn =>
  ({ id, table: 'pipe', a, b, shape: 'round', w: d, h: d, system });

describe('clash core (editor copy)', () => {
  it('crossing pipes of two systems are medium; the same pipes 0.2 m apart are clear', () => {
    const at = (z: number) => detectClashes({ curves: [pipe('a', [0, 0, 3], [10, 0, 3], 0.1, 'CHWS'), pipe('b', [5, -5, z], [5, 5, z], 0.1, 'HWS')], hosts: [] });
    const [c] = at(3);
    expect(c).toMatchObject({ a: 'a', b: 'b', severity: 'medium', kind: 'hard', systems: ['CHWS', 'HWS'] });
    expect(c.at[0]).toBeCloseTo(5, 3);
    expect(c.depth).toBeCloseTo(0.1, 3);
    expect(at(3.2)).toEqual([]);
    // clearance 150 mm: the 100 mm gap is reported
    expect(detectClashes({ curves: [pipe('a', [0, 0, 3], [10, 0, 3], 0.1, 'X'), pipe('b', [5, -5, 3.2], [5, 5, 3.2], 0.1, 'Y')], hosts: [] }, { clearance: 0.15 })
      .map(x => [x.kind, Math.round(x.depth * 1000)])).toEqual([['clearance', 100]]);
  });

  it('pairs sharing a fitting node are connected', () => {
    const curves = [
      { ...pipe('a', [0, 0, 3], [5, 0, 3], 0.1, ''), to: 'mn-1' },
      { ...pipe('b', [5, 0, 3], [10, 0, 3], 0.1, 'Y'), from: 'mn-1' },
    ];
    // Different systems, but both end on mn-1.
    expect(detectClashes({ curves, hosts: [{ id: 'mn-1', table: 'mep_node', center: [5, 0, 3], half: [0, 0, 0], system: '', fitting: true }] })).toEqual([]);
  });
});

describe('clash detection in the editor', () => {
  it('a duct drawn across a beam is high; a tee drawn with the router is not a clash', () => {
    const h = createHarness();
    h.pick('beam', { start_z: '3', end_z: '3', size_x: '0.3', size_y: '0.5', shape: 'rect' });
    h.click(0, 4); h.click(10, 4);
    h.done();
    h.pick('duct', { start_z: '2.8', system_type: 'SA', size_x: '0.4', size_y: '0.3', shape: 'rect' });
    h.click(2, 0); h.click(2, 8);
    h.done();
    // A branch teed into the duct body (the router splits the main at a tee node).
    h.pick('duct', { start_z: '2.8', system_type: 'SA', size_x: '0.3', size_y: '0.2', shape: 'rect' });
    h.click(6, 1); h.click(2, 1);
    h.done();
    const clashes = clashesOf(h.state);
    const beam = [...h.state.document!.elements.values()].find(e => e.tableName === 'beam')!;
    expect(clashes.map(c => [c.bTable, c.severity, c.kind])).toEqual([['beam', 'high', 'hard']]);
    expect(clashes[0].b).toBe(beam.id);
    expect(clashes[0].at[1]).toBeCloseTo(4, 1);
    expect(clashes[0].at[2]).toBeGreaterThan(2.5);
  });

  it('includes the slab and beams of the level above, with their level as scope', async () => {
    const files = sampleProject();
    // lv-1: a riser through lv-2's slab (ss-1: 3.3 – 3.5) and a duct through bm-1 (2.9 – 3.5) at 3.2.
    files['lv-1/duct.csv'] = 'id,shape,size_x,size_y,system_type\ndu-1,rect,0.3,0.3,EA\ndu-2,rect,0.3,0.2,SA\n';
    files['lv-1/duct.geojson'] = fc([
      { type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[5, 3.5, 2.5], [5, 3.5, 5]] } },
      { type: 'Feature', properties: { id: 'du-2' }, geometry: { type: 'LineString', coordinates: [[1, 0.5, 3.2], [1, 3.5, 3.2]] } },
    ]);
    const project = await loadProject(memoryDataSource(files));
    const els = new Map(parseFloorLayers(project.floors.get('lv-1')!.layers).map(e => [e.id, e]));
    const clashes = detectClashes(buildClashModel(createDocument('lv-1', [...els.values()]).elements, { project, levelId: 'lv-1' }));
    const got = clashes.map(c => `${c.a}>${c.b}@${c.bScope}:${c.severity}:${c.kind}`).sort();
    expect(got).toEqual(['du-1>ss-1@lv-2:low:penetration', 'du-2>bm-1@lv-2:high:hard']);
    // Points stay in lv-1's frame
    const riser = clashes.find(c => c.a === 'du-1')!;
    expect(riser.at[2]).toBeGreaterThanOrEqual(3.3 - 1e-6);
    expect(riser.at[2]).toBeLessThanOrEqual(3.5 + 1e-6);
  });

  it('a picked clash zooms the plan; the 3D section box uses absolute z', () => {
    vi.stubGlobal('window', new EventTarget());
    let got: unknown = null;
    window.addEventListener('bimdown:zoom-to', e => { got = (e as CustomEvent).detail; });
    zoomPlanTo([5, 4, 2.8], 1);
    vi.unstubAllGlobals();
    expect(got).toEqual({ minX: 4, minY: 3, maxX: 6, maxY: 5 });
    const b = clashSectionBox([5, 4, 2.8], 3.6, 3, 2, 0.6);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([2, 8, 1, 7]);
    expect(b.minZ).toBeCloseTo(4.4, 6);
    expect(b.maxZ).toBeCloseTo(7.0, 6);
  });
});
