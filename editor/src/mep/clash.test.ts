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

  it('a wall of the level below rising into this one clashes; one stopping at the floor does not (audit r3)', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,4\nlv-3,3,L3,8\n',
      // w-1 spans two storeys (lv-1 → lv-3), w-2 stops at lv-2
      'lv-1/structure_wall.csv': 'id,number,thickness,top_level_id\nw-1,,0.3,lv-3\nw-2,,0.3,lv-2\n',
      'lv-1/structure_wall.geojson': fc([
        { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[5, 0], [5, 10]] } },
        { type: 'Feature', properties: { id: 'w-2' }, geometry: { type: 'LineString', coordinates: [[8, 0], [8, 10]] } },
      ]),
      'lv-2/duct.csv': 'id,shape,size_x,size_y,system_type\ndu-1,rect,0.4,0.3,SA\n',
      'lv-2/duct.geojson': fc([{ type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[0, 5, 6.5], [10, 5, 6.5]] } }]),
    };
    const project = await loadProject(memoryDataSource(files));
    const els = new Map(parseFloorLayers(project.floors.get('lv-2')!.layers).map(e => [e.id, e]));
    const clashes = detectClashes(buildClashModel(createDocument('lv-2', [...els.values()]).elements, { project, levelId: 'lv-2' }));
    expect(clashes.map(c => `${c.a}>${c.b}@${c.bScope}:${c.severity}`)).toEqual(['du-1>w-1@lv-1:high']);
  });

  it('a duct through an open-web joist web is clear; through its chord it clashes', () => {
    const joist = { id: 'bm-1', tableName: 'beam', discipline: 'structure', geometry: 'spatial_line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, startZ: 3, endZ: 3, strokeWidth: 0.073,
      attrs: { id: 'bm-1', shape: 'open_web', size_x: '0.073', size_y: '0.356', flange: '0.032', material: 'steel' } };
    const duct = (id: string, z: number) => ({ id, tableName: 'duct', discipline: 'mep', geometry: 'spatial_line', start: { x: 5, y: -3 }, end: { x: 5, y: 3 }, startZ: z, endZ: z, strokeWidth: 0.15,
      attrs: { id, shape: 'round', size_x: '0.15', system_type: 'SA' } });
    const els = new Map([joist, duct('du-1', 2.82), duct('du-2', 2.98)].map(e => [e.id, e])) as never;
    expect(detectClashes(buildClashModel(els, {})).map(c => c.a)).toEqual(['du-2']);
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
