import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { parseLayer } from './parse.ts';
import { serializeToGeoJson, serializeToCsv } from './serialize.ts';
import type { CanonicalElement, LineElement, PointElement, PolygonElement } from './elements.ts';
import type { LayerData, Level, GridData } from '../types.ts';
import { fc } from '../test/memoryDataSource.ts';
import { getElementModule } from '../elements/registry.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { getDefaultDrawingAttrs, getDrawingFields } from './drawingSchema.ts';
import {
  beamSystemLines, beamsBetweenColumns, gridBayAt, gridDirections, gridIntersections, rectBay,
} from './structuralLayout.ts';
import { columnFootprint, trimAtColumns } from '../elements/_framing.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import { createDocument } from './document.ts';
import { elementQuantities } from './quantities.ts';
import { isLayerVisibleInView } from '../state/selectors.ts';
import type { EditorState } from '../state/editorTypes.ts';

const levels: Level[] = [
  { id: 'lv-1', number: '1', name: 'L1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'L2', elevation: 4 },
  { id: 'lv-3', number: '3', name: 'L3', elevation: 7.6 },
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

const F = (id: string, geometry: unknown, props: Record<string, unknown> = {}) =>
  ({ type: 'Feature', properties: { id, ...props }, geometry });

function ctxFor(elements: CanonicalElement[], levelId = 'lv-1') {
  return buildGeometryContext({
    level: levels.find(l => l.id === levelId)!,
    allLevels: levels,
    allElements: new Map(elements.map(e => [e.id, e])),
  });
}

describe('foundation semantics (spec foundation.yaml)', () => {
  const els = parseLayer(layer('foundation',
    'id,number,kind,thickness,width,length\nf-1,F1,,0.6,2.0,2.4\nf-2,P1,pile,18,0.8,\nf-3,SF1,,0.5,1.2,\nf-4,OLD,,0.5,,',
    [
      F('f-1', { type: 'Point', coordinates: [0, 0] }),
      F('f-2', { type: 'Point', coordinates: [6, 0] }),
      F('f-3', { type: 'LineString', coordinates: [[0, 12], [12, 12]] }),
      F('f-4', { type: 'Point', coordinates: [12, 0] }),
    ]));
  const mod = getElementModule('foundation')!;
  const ctx = ctxFor(els);
  const facts = (id: string) => mod.geometry(els.find(e => e.id === id)!, ctx) as any;

  it('a Point pad is width × length, not a 0.3 m box', () => {
    const pad = els.find(e => e.id === 'f-1') as PointElement;
    expect(pad.width).toBe(2.0);
    expect(pad.height).toBe(2.4);
    expect(facts('f-1')).toMatchObject({ form: 'point', kind: 'pad', width: 2.0, depth: 2.4, round: false });
  });

  it('a pile is round with diameter = width and hangs down by its length', () => {
    expect(facts('f-2')).toMatchObject({ kind: 'pile', width: 0.8, depth: 0.8, round: true, thickness: 18, baseY: -18 });
  });

  it('a strip footing takes its plan width from `width`, not `thickness`', () => {
    const f = facts('f-3');
    expect(f.form).toBe('line');
    expect(f.strokeWidth).toBe(1.2);
    expect((els.find(e => e.id === 'f-3') as LineElement).strokeWidth).toBe(1.2);
  });

  it('a pad without sizes falls back to the 1.5 m default, not 0.3', () => {
    expect((els.find(e => e.id === 'f-4') as PointElement).width).toBe(1.5);
  });

  it('round-trips width / length without inventing size_x / size_y columns', () => {
    const csv = serializeToCsv(els, 'foundation');
    expect(csv.split('\n')[0]).not.toMatch(/size_x|size_y/);
    expect(csv).toContain('f-1,F1,,,0.6,2.0,2.4');
  });

  it('the isolated / pile toolbar variants seed their own fields', () => {
    const pad = getDefaultDrawingAttrs('foundation', 'lv-1', levels, 'isolated');
    expect(pad).toMatchObject({ kind: 'pad', width: '1.5', length: '1.5' });
    expect(getDrawingFields('foundation', levels, 'isolated').map(f => f.key)).toEqual(['width', 'length', 'thickness', 'material', 'base_offset']);
    const pile = getDrawingFields('foundation', levels, 'pile');
    expect(pile.find(f => f.key === 'width')!.label).toBe('Diameter');
    expect(getDefaultDrawingAttrs('foundation', 'lv-1', levels, 'pile').kind).toBe('pile');
  });

  it('resizing a pad updates width / length', () => {
    const pad = els.find(e => e.id === 'f-1')!;
    const state = { ...initialState, document: createDocument('lv-1', [pad]) } as EditorState;
    const next = editorReducer(state, { type: 'RESIZE_ELEMENT', id: 'f-1', changes: { width: 3 } as any });
    expect(next.document!.elements.get('f-1')!.attrs.width).toBe('3');
    const upd = editorReducer(state, { type: 'UPDATE_ATTRS', id: 'f-1', attrs: { length: '3.2' } });
    expect((upd.document!.elements.get('f-1') as PointElement).height).toBe(3.2);
  });
});

describe('vertical defaults', () => {
  it('a column without top_level_id runs to the level above (not 3 m)', () => {
    const cols = parseLayer(layer('structure_column', 'id,number,shape,size_x,size_y\nsc-1,C1,rect,0.5,0.5',
      [F('sc-1', { type: 'Point', coordinates: [0, 0] })]));
    const f = getElementModule('structure_column')!.geometry(cols[0], ctxFor(cols, 'lv-2')) as any;
    expect(f.extrudeHeight).toBeCloseTo(3.6);
  });

  it('beams default to top = this level; braces span the storey', () => {
    const beam = getDefaultDrawingAttrs('beam', 'lv-2', levels, 'single');
    expect(beam.start_z).toBe('0');
    expect(beam.end_z).toBe('0');
    const brace = getDefaultDrawingAttrs('brace', 'lv-2', levels);
    expect(brace.start_z).toBe('0');
    expect(brace.end_z).toBe('3.6');
    expect(getDefaultDrawingAttrs('brace', 'lv-3', levels).end_z).toBe('3'); // top level: 3 m
  });
});

describe('slab inner rings (holes) survive read / write', () => {
  it('keeps every ring of a Polygon', () => {
    const outer = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const els = parseLayer(layer('structure_slab', 'id,number,thickness\nss-1,S1,0.2',
      [F('ss-1', { type: 'Polygon', coordinates: [outer, hole] })]));
    expect((els[0] as PolygonElement).holes).toHaveLength(1);
    const out = JSON.parse(serializeToGeoJson(els));
    expect(out.features[0].geometry.coordinates).toEqual([outer, hole]);
    const facts = getElementModule('structure_slab')!.geometry(els[0], ctxFor(els)) as any;
    expect(facts.holes).toHaveLength(1);
    expect(elementQuantities(els[0], 0, new Map()).area).toBeCloseTo(80 - 4);
  });

  it('moves holes with the slab', () => {
    const els = parseLayer(layer('structure_slab', 'id,number,thickness\nss-1,S1,0.2',
      [F('ss-1', { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] })]));
    const state = { ...initialState, document: createDocument('lv-1', els) } as EditorState;
    const next = editorReducer(state, { type: 'MOVE_ELEMENTS', ids: ['ss-1'], dx: 10, dy: 0 });
    expect((next.document!.elements.get('ss-1') as PolygonElement).holes![0][0]).toEqual({ x: 11, y: 1 });
  });
});

const grid3x3: GridData[] = [
  ...[0, 6, 12].map((x, i) => ({ id: `gr-${i + 1}`, number: String(i + 1), x1: x, y1: -2, x2: x, y2: 14 })),
  ...[0, 6, 12].map((y, i) => ({ id: `gr-${i + 11}`, number: 'ABC'[i], x1: -2, y1: y, x2: 14, y2: y })),
];

describe('grid-driven layout', () => {
  it('finds the 9 crossings of a 3 × 3 grid', () => {
    expect(gridIntersections(grid3x3)).toHaveLength(9);
  });

  it('beams between neighbouring columns: 12 on a 3 × 3 grid, no diagonals or skips', () => {
    const cols = gridIntersections(grid3x3);
    const beams = beamsBetweenColumns(cols, gridDirections(grid3x3));
    expect(beams).toHaveLength(12);
    for (const [a, b] of beams) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(6);
    // Existing beams are not duplicated.
    expect(beamsBetweenColumns(cols, gridDirections(grid3x3), beams)).toHaveLength(0);
  });

  it('finds the bay around a point and fills it with a beam system', () => {
    const bay = gridBayAt({ x: 8, y: 3 }, grid3x3)!;
    const xs = bay.map(p => p.x).sort((a, b) => a - b);
    expect([xs[0], xs[3]]).toEqual([6, 12]);
    expect(gridBayAt({ x: 20, y: 3 }, grid3x3)).toBeNull();
    // 6 × 9 bay, ≤ 2 m spacing across the short span: beams 6 long, 4 of them (9 / 5 = 1.8 m).
    const lines = beamSystemLines(rectBay({ x: 0, y: 0 }, { x: 6, y: 9 }), 2, 'short');
    expect(lines).toHaveLength(4);
    for (const [a, b] of lines) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(6);
    expect(beamSystemLines(rectBay({ x: 0, y: 0 }, { x: 6, y: 9 }), 2, 'long')).toHaveLength(2);
  });
});

describe('beams and columns', () => {
  const cols = parseLayer(layer('structure_column', 'id,number,shape,size_x,size_y\nsc-1,,rect,0.6,0.6\nsc-2,,round,0.5,',
    [F('sc-1', { type: 'Point', coordinates: [0, 0] }), F('sc-2', { type: 'Point', coordinates: [6, 0] })]));
  const beams = parseLayer(layer('beam', 'id,number,shape,size_x,size_y\nbm-1,KL1,rect,0.3,0.6',
    [F('bm-1', { type: 'LineString', coordinates: [[0, 0, 0], [6, 0, 0]] })]));

  it('plan drawing stops at the column faces', () => {
    const fps = cols.map(columnFootprint).filter(Boolean) as any[];
    const [t0, t1] = trimAtColumns({ x: 0, y: 0 }, { x: 6, y: 0 }, fps);
    expect(t0 * 6).toBeCloseTo(0.3);
    expect(t1 * 6).toBeCloseTo(6 - 0.25);
  });

  it('a beam end follows its moved column; the other end stays', () => {
    const state = { ...initialState, document: createDocument('lv-1', [...cols, ...beams]) } as EditorState;
    const next = editorReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:sc-2'], dx: 1, dy: 2 });
    const bm = next.document!.elements.get('bm-1') as LineElement;
    expect(bm.start).toEqual({ x: 0, y: 0 });
    expect(bm.end).toEqual({ x: 7, y: 2 });
    // One undo restores both.
    const undone = editorReducer(next, { type: 'UNDO' });
    expect((undone.document!.elements.get('bm-1') as LineElement).end).toEqual({ x: 6, y: 0 });
  });

  it('quantities: column, beam volume', () => {
    const elev = new Map(levels.map(l => [l.id, l.elevation]));
    expect(elementQuantities(cols[0], 0, elev).volume).toBeCloseTo(0.36 * 4);
    expect(elementQuantities(beams[0], 0, elev).volume).toBeCloseTo(0.18 * 6);
  });
});

describe('architecture view shows structure', () => {
  it('structural columns / walls / slabs are visible in the architecture view', () => {
    const state = { ...initialState, activeDiscipline: 'architecture' } as EditorState;
    expect(isLayerVisibleInView('structure', 'structure_column', state)).toBe(true);
    expect(isLayerVisibleInView('structure', 'beam', state)).toBe(false);
    const off = { ...state, viewOptions: { ...state.viewOptions, showStructureInArch: false } };
    expect(isLayerVisibleInView('structure', 'structure_column', off)).toBe(false);
  });
});
