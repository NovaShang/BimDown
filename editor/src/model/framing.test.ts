import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { parseFloorLayers, parseLayer } from './parse.ts';
import type { CanonicalElement, LineElement } from './elements.ts';
import type { GridData, LayerData, Level, ProjectData } from '../types.ts';
import { fc } from '../test/memoryDataSource.ts';
import { getElementModule } from '../elements/registry.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { beamSegments, trimAtBeams } from '../elements/_framing.ts';
import { memberBodyEnds, type BeamFacts } from '../elements/beam.tsx';
import { columnsToppingAt } from './framingLevels.ts';
import { beamsBetweenColumnsIn } from '../tools/drawRegionTool.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import { createDocument } from './document.ts';
import type { EditorState } from '../state/editorTypes.ts';
import type { ToolStateSnapshot } from '../tools/types.ts';

const levels: Level[] = [
  { id: 'lv-1', number: '1', name: 'L1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'L2', elevation: 4 },
  { id: 'lv-3', number: '3', name: 'Roof', elevation: 7.6 },
];

function layer(tableName: string, csv: string, features: unknown[], discipline = 'structure'): LayerData {
  const [head, ...rows] = csv.trim().split('\n');
  const keys = head.split(',');
  const csvRows = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const vals = r.split(',');
    const row: Record<string, string> = {};
    keys.forEach((k, i) => { row[k] = vals[i] ?? ''; });
    csvRows.set(row.id, row);
  }
  return { tableName, discipline, geojsonContent: fc(features), csvRows };
}
const F = (id: string, geometry: unknown) => ({ type: 'Feature', properties: { id }, geometry });
const line = (id: string, a: [number, number], b: [number, number], z = 0) => F(id, { type: 'LineString', coordinates: [[...a, z], [...b, z]] });

function project(floors: Record<string, LayerData[]>): ProjectData {
  return {
    levels,
    floors: new Map(Object.entries(floors).map(([levelId, layers]) => [levelId, { levelId, levelName: levelId, layers }])),
    globalLayers: [], mepSystems: [], metadata: {} as ProjectData['metadata'],
  };
}

describe('secondary beams stop at girder faces', () => {
  // Girders on y = 0 and y = 6 (300 wide), an infill beam between them (250 wide), a corner beam
  const beams = parseLayer(layer('beam', 'id,number,shape,size_x,size_y\nbm-1,,rect,0.3,0.6\nbm-2,,rect,0.3,0.6\nbm-3,,rect,0.25,0.45\nbm-4,,rect,0.3,0.6',
    [line('bm-1', [0, 0], [8, 0]), line('bm-2', [0, 6], [8, 6]), line('bm-3', [4, 0], [4, 6]), line('bm-4', [0, 0], [0, 6])]));
  const ctx = buildGeometryContext({ level: levels[0], allLevels: levels, allElements: new Map(beams.map(e => [e.id, e])) });
  const facts = (id: string) => getElementModule('beam')!.geometry(beams.find(b => b.id === id)!, ctx) as BeamFacts;

  it('cuts an infill beam back by half the girder width at both ends (plan and 3D)', () => {
    const [t0, t1] = trimAtBeams('bm-3', { x: 4, y: 0 }, { x: 4, y: 6 }, 0, beamSegments(ctx));
    expect(t0 * 6).toBeCloseTo(0.15, 9);
    expect(t1 * 6).toBeCloseTo(6 - 0.15, 9);
    const b = memberBodyEnds(facts('bm-3'));
    expect(b.start.y).toBeCloseTo(0.15, 9);
    expect(b.end.y).toBeCloseTo(5.85, 9);
    expect(Math.min(...facts('bm-3').footprint2D.map(p => p.y))).toBeCloseTo(0.15, 9);
  });

  it('leaves girders and beams meeting at their ends alone', () => {
    expect(facts('bm-1').body).toEqual([0, 1]);
    // bm-4 meets bm-1 / bm-2 at their end points: a corner, not a join into a span
    expect(facts('bm-4').body).toEqual([0, 1]);
  });

  it('ignores beams at another height', () => {
    const segs = beamSegments(ctx).map(s => ({ ...s, z: -2 }));
    expect(trimAtBeams('bm-3', { x: 4, y: 0 }, { x: 4, y: 6 }, 0, segs)).toEqual([0, 1]);
  });
});

describe('framing across levels', () => {
  const grids: GridData[] = [
    { id: 'gr-1', number: '1', x1: 0, y1: -2, x2: 0, y2: 10 }, { id: 'gr-2', number: '2', x1: 7.2, y1: -2, x2: 7.2, y2: 10 },
    { id: 'gr-3', number: 'A', x1: -2, y1: 0, x2: 10, y2: 0 }, { id: 'gr-4', number: 'B', x1: -2, y1: 8.4, x2: 10, y2: 8.4 },
  ];
  const l2Columns = layer('structure_column', 'id,number,shape,size_x,size_y,top_level_id\nsc-1,,rect,0.5,0.5,\nsc-2,,rect,0.5,0.5,\nsc-3,,rect,0.5,0.5,lv-3\nsc-4,,rect,0.5,0.5,',
    [F('sc-1', { type: 'Point', coordinates: [0, 0] }), F('sc-2', { type: 'Point', coordinates: [7.2, 0] }),
      F('sc-3', { type: 'Point', coordinates: [7.2, 8.4] }), F('sc-4', { type: 'Point', coordinates: [0, 8.4] })]);
  // An L1 column that stops at L2 does not reach the roof
  const l1Columns = layer('structure_column', 'id,number,shape,size_x,size_y\nsc-1,,rect,0.5,0.5', [F('sc-1', { type: 'Point', coordinates: [20, 20] })]);

  it('a roof is framed on the columns below whose top is the roof (S3)', () => {
    const p = project({ 'lv-1': [l1Columns], 'lv-2': [l2Columns], 'lv-3': [] });
    expect(columnsToppingAt(p, 'lv-3').map(c => c.id).sort()).toEqual(['sc-1', 'sc-2', 'sc-3', 'sc-4']);
    expect(columnsToppingAt(p, 'lv-2').map(c => c.position)).toEqual([{ x: 20, y: 20 }]);
    const state = {
      document: createDocument('lv-3', []), project: p, grids,
      drawingTarget: { tableName: 'beam', discipline: 'structure', variantId: 'between_columns' }, drawingAttrs: {},
    } as unknown as ToolStateSnapshot;
    const beams = beamsBetweenColumnsIn(state, { x: -1, y: -1 }, { x: 9, y: 9 }, false);
    expect(beams).toHaveLength(4);
    expect(beams.every(b => b.tableName === 'beam')).toBe(true);
  });

  it('beams on the level above follow a moved column; one undo restores both levels', () => {
    const roofBeams = layer('beam', 'id,number,shape,size_x,size_y\nbm-1,,rect,0.3,0.6\nbm-2,,rect,0.3,0.6',
      [line('bm-1', [0, 0], [7.2, 0], 4), line('bm-2', [7.2, 0], [7.2, 8.4], 4)]);
    const p = project({ 'lv-1': [], 'lv-2': [roofBeams] });
    const cols = parseLayer(l2Columns);
    const state = { ...initialState, project: p, currentLevel: 'lv-1', document: createDocument('lv-1', cols) } as EditorState;
    const next = editorReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:sc-2'], dx: 0.5, dy: 0 });
    expect(next.document!.elements.get('sc-2')!.geometry === 'point' && (next.document!.elements.get('sc-2') as any).position).toEqual({ x: 7.7, y: 0 });
    const above = new Map(parseFloorLayers(next.project!.floors.get('lv-2')!.layers).map(e => [e.id, e as LineElement]));
    expect(above.get('bm-1')!.end).toEqual({ x: 7.7, y: 0 });
    expect(above.get('bm-1')!.start).toEqual({ x: 0, y: 0 });
    expect(above.get('bm-2')!.start).toEqual({ x: 7.7, y: 0 });
    const undone = editorReducer(next, { type: 'UNDO' });
    const back = new Map(parseFloorLayers(undone.project!.floors.get('lv-2')!.layers).map(e => [e.id, e as LineElement]));
    expect(back.get('bm-1')!.end).toEqual({ x: 7.2, y: 0 });
    expect((undone.document!.elements.get('sc-2') as CanonicalElement & { position: { x: number } }).position.x).toBe(7.2);
  });

  it('copy to the top level turns floor slabs into roof slabs (option)', () => {
    const slab = parseLayer(layer('structure_slab', 'id,number,thickness,function\nss-1,,0.2,floor', [F('ss-1', { type: 'Polygon', coordinates: [[[0, 0], [7, 0], [7, 8], [0, 8], [0, 0]]] })]));
    const p = project({ 'lv-1': [], 'lv-2': [], 'lv-3': [] });
    const state = { ...initialState, project: p, currentLevel: 'lv-1', document: createDocument('lv-1', slab) } as EditorState;
    const fn = (s: EditorState, lv: string) => parseFloorLayers(s.project!.floors.get(lv)!.layers).find(e => e.tableName === 'structure_slab')?.attrs.function;
    const on = editorReducer(state, { type: 'COPY_TO_LEVELS', ids: ['lv-1:ss-1'], levelIds: ['lv-2', 'lv-3'], roofOnTop: true });
    expect([fn(on, 'lv-2'), fn(on, 'lv-3')]).toEqual(['floor', 'roof']);
    const off = editorReducer(state, { type: 'COPY_TO_LEVELS', ids: ['lv-1:ss-1'], levelIds: ['lv-3'] });
    expect(fn(off, 'lv-3')).toBe('floor');
  });
});
