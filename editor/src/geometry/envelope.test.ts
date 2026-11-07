import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, LineElement, PolygonElement, Point } from '../model/elements.ts';
import { pickLoop, boundaryAt } from './pickBoundary.ts';
import { attachSurface, wallTopPieces, maxTop } from './attach.ts';
import { insertVertexChanges, removeVertexChanges } from './polygonEdit.ts';
import { signedArea } from './roofSolver.ts';
import { polygonOpeningAttrs } from '../tools/drawPolygonTool.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { buildCrossLevelIndex } from '../model/crossLevel.ts';
import { getElementModule } from '../elements/registry.ts';
import type { SlabFacts } from '../elements/_slabShared.tsx';
import type { LineWallFacts } from '../elements/_lineWallShared.tsx';
import type { ProjectData, LayerData } from '../types.ts';
import { wallSolid } from '../elements/_lineWallShared.tsx';

const wall = (id: string, a: Point, b: Point, t = 0.2, attrs: Record<string, string> = {}): LineElement => ({
  id, tableName: 'wall', discipline: 'architecture', geometry: 'line', start: a, end: b, strokeWidth: t,
  attrs: { thickness: String(t), ...attrs },
});
const poly = (id: string, table: string, vertices: Point[], attrs: Record<string, string> = {}): PolygonElement => ({
  id, tableName: table, discipline: 'architecture', geometry: 'polygon', vertices, attrs,
});
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const area = (p: Point[] | null) => Math.abs(signedArea(p ?? []));

// 10 × 8 box of 0.2 m walls with a partition at x = 6.
const box = [
  wall('w-1', { x: 0, y: 0 }, { x: 10, y: 0 }), wall('w-2', { x: 10, y: 0 }, { x: 10, y: 8 }),
  wall('w-3', { x: 10, y: 8 }, { x: 0, y: 8 }), wall('w-4', { x: 0, y: 8 }, { x: 0, y: 0 }),
  wall('w-5', { x: 6, y: 0 }, { x: 6, y: 8 }, 0.1),
];

describe('pick boundary (floor / roof / ceiling by walls)', () => {
  it('a wall picks the whole outline; faces move the boundary', () => {
    const loop = pickLoop({ x: 5, y: 0.05 }, box)!;
    expect(loop.outer).toBe(true);
    expect(area(loop.outline)).toBeCloseTo(80);
    expect(area(boundaryAt(loop, 'exterior'))).toBeCloseTo(10.2 * 8.2);
    expect(area(boundaryAt(loop, 'interior'))).toBeCloseTo(9.8 * 7.8);
    expect(area(boundaryAt(loop, 'centerline'))).toBeCloseTo(80);
    // Roof: exterior face + 0.5 m overhang.
    expect(area(boundaryAt(loop, 'exterior', undefined, 0.5))).toBeCloseTo(11.2 * 9.2);
    expect(boundaryAt(loop, 'exterior')!.length).toBe(4);
  });

  it('a click inside a room picks that room at its wall faces', () => {
    const loop = pickLoop({ x: 3, y: 4 }, box)!;
    expect(loop.outer).toBe(false);
    // 0.1 off the outer walls, 0.05 off the 0.1 partition.
    expect(area(boundaryAt(loop, 'interior'))).toBeCloseTo((6 - 0.1 - 0.05) * 7.8);
    expect(pickLoop({ x: 20, y: 20 }, box)).toBeNull();
  });
});

describe('wall top attached to a roof', () => {
  const roof = poly('ro-1', 'roof', rect(-0.5, -0.5, 10.5, 8.5), { roof_type: 'gable', edge_slopes: '45;0;45;0', base_offset: '3', thickness: '0.2' });

  it('follows the underside where the wall is under the roof', () => {
    const surface = attachSurface(roof, 0)!;
    // Gable end wall along x = 10 from y 0..8: peak at mid-span (rise 4.5 above the eaves at y = 4).
    const fp = rect(9.9, 0, 10.1, 8);
    const pieces = wallTopPieces(fp, surface, 3);
    expect(maxTop(pieces)).toBeCloseTo(3 + 4.5, 6);
    const at = (p: Point) => {
      for (const pc of pieces) if (pointIn(p, pc.poly)) return pc.top.a * p.x + pc.top.b * p.y + pc.top.c;
      return NaN;
    };
    expect(at({ x: 10, y: 1 })).toBeCloseTo(3 + 1.5);
    expect(at({ x: 10, y: 4 })).toBeCloseTo(7.5);
  });

  it('keeps its own top outside the roof, and wall geometry reports the new height', () => {
    const surface = attachSurface(roof, 0)!;
    const pieces = wallTopPieces(rect(10, 2, 12, 2.2), surface, 2.8);
    const outside = pieces.find(pc => pc.poly.every(p => p.x >= 10.5 - 1e-9))!;
    expect(outside.top.c).toBeCloseTo(2.8);
    const w = wall('w-9', { x: 0, y: 4 }, { x: 10, y: 4 }, 0.2, { top_attach_id: 'ro-1' });
    const els = new Map<string, CanonicalElement>([[w.id, w], [roof.id, roof]]);
    const ctx = buildGeometryContext({ level: { id: 'lv-1', number: '', name: '', elevation: 0 }, allLevels: [], allElements: els });
    const f = getElementModule('wall')!.geometry(w, ctx) as LineWallFacts;
    expect(f.topAttach).toBeDefined();
    expect(f.height).toBeCloseTo(7.5, 6); // the ridge runs along the wall
  });

  it('builds a closed gable-end wall solid (with a door cut) under the roof', () => {
    const w = wall('w-8', { x: 10, y: 0 }, { x: 10, y: 8 }, 0.2, { top_attach_id: 'ro-1' });
    const els = new Map<string, CanonicalElement>([[w.id, w], [roof.id, roof]]);
    const ctx = buildGeometryContext({ level: { id: 'lv-1', number: '', name: '', elevation: 0 }, allLevels: [], allElements: els });
    const f = getElementModule('wall')!.geometry(w, ctx) as LineWallFacts;
    // top(y) = 3 + min(y + 0.5, 8.5 − y): ∫ over 0..8 = 44 → × 0.2 thick
    expect(meshVolume(wallSolid(f, f.footprint))).toBeCloseTo(8.8, 3);
    const withDoor = { ...f, openings: [{ hostedId: 'd-1', hostedTable: 'door' as const, position: 4, width: 1, height: 2, sillHeight: 0, shape: 'rect' as const }] };
    expect(meshVolume(wallSolid(withDoor, f.footprint))).toBeCloseTo(8.8 - 0.4, 3);
  });
});

function pointIn(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe('boundary editing', () => {
  it('inserting / deleting vertices keeps edge_slopes per edge', () => {
    const r = poly('ro-1', 'roof', rect(0, 0, 10, 6), { edge_slopes: '30;0;30;0' });
    const ins = insertVertexChanges(r, 0, { x: 5, y: -1 });
    expect(ins.vertices.length).toBe(5);
    expect(ins.attrs.edge_slopes).toBe('30;30;0;30;0');
    const del = removeVertexChanges({ ...r, ...ins }, 1)!;
    expect(del.vertices).toEqual(r.vertices);
    expect(del.attrs.edge_slopes).toBe('30;0;30;0');
    expect(removeVertexChanges(poly('s', 'slab', rect(0, 0, 1, 1).slice(0, 3)), 0)).toBeNull();
  });
});

describe('slab openings and shafts', () => {
  const slab = poly('sl-1', 'slab', rect(0, 0, 10, 8), { thickness: '0.2' });
  const roof = poly('ro-1', 'roof', rect(-1, -1, 11, 9), {});
  const els = new Map<string, CanonicalElement>([[slab.id, slab], [roof.id, roof]]);
  const hole = rect(2, 2, 3, 3);

  it('a sketched opening is hosted on the smallest floor / roof under it', () => {
    const a = polygonOpeningAttrs({ width: '1', shape: 'rect', top_level_id: 'lv-2' }, hole, els, false)!;
    expect(a.host_id).toBe('sl-1');
    expect(a.top_level_id).toBe('');
    expect(a.width).toBe('');
    expect(polygonOpeningAttrs({}, rect(20, 20, 21, 21), els, false)).toBeNull();
    const s = polygonOpeningAttrs({ top_level_id: 'lv-3' }, rect(20, 20, 21, 21), els, true)!;
    expect(s.host_id).toBe('');
    expect(s.top_level_id).toBe('lv-3');
  });

  it('a shaft cuts the slabs of every level it spans', () => {
    const layer = (table: string, csv: string, features: unknown[]): LayerData => ({
      tableName: table, discipline: 'architecture', csvRows: parseRows(csv),
      geojsonContent: JSON.stringify({ type: 'FeatureCollection', features }),
    });
    const slabFeature = (id: string) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]] } });
    const levels = [0, 3, 6, 9].map((e, i) => ({ id: `lv-${i + 1}`, number: '', name: `L${i + 1}`, elevation: e }));
    const floors = new Map(levels.map(l => [l.id, {
      levelId: l.id, levelName: l.name,
      layers: [layer('slab', `id,thickness\nsl-${l.id},0.2`, [slabFeature(`sl-${l.id}`)])]
        .concat(l.id === 'lv-1' ? [layer('opening', 'id,host_id,top_level_id,base_offset\nop-1,,lv-3,0', [
          { type: 'Feature', properties: { id: 'op-1' }, geometry: { type: 'Polygon', coordinates: [[[4, 4], [5, 4], [5, 5], [4, 5], [4, 4]]] } },
        ])] : []),
    }]));
    const project = { levels, floors, globalLayers: [], mepSystems: [], metadata: { format_version: '1' } } as unknown as ProjectData;
    const crossLevel = buildCrossLevelIndex(project);
    expect(crossLevel.shafts.length).toBe(1);
    const holesAt = (lv: typeof levels[number]) => {
      const s = poly(`sl-${lv.id}`, 'slab', rect(0, 0, 10, 8), { thickness: '0.2' });
      const ctx = buildGeometryContext({ level: lv, allLevels: levels, allElements: new Map([[s.id, s]]), crossLevel });
      return (getElementModule('slab')!.geometry(s, ctx) as SlabFacts).holes.length;
    };
    // Shaft from L1 (0) to L3 (6): the L1 slab hangs below 0 → not cut; L2 and L3 cut; L4 not.
    expect(levels.map(holesAt)).toEqual([0, 1, 1, 0]);
  });
});

function parseRows(csv: string): Map<string, Record<string, string>> {
  const [head, ...rows] = csv.trim().split('\n');
  const cols = head.split(',');
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const vals = r.split(',');
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { row[c] = vals[i] ?? ''; });
    out.set(row.id, row);
  }
  return out;
}

function meshVolume(geo: import('three').BufferGeometry): number {
  const p = geo.getAttribute('position');
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, ay, az] = [p.getX(i), p.getY(i), p.getZ(i)];
    const [bx, by, bz] = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    const [cx, cy, cz] = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}
