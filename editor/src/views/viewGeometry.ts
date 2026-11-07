/**
 * Pure geometry for elevation and section views. Plan coordinates (x, y) with
 * z = absolute elevation; three.js world is (x, z, -y).
 *
 * A view looks along `dir` (horizontal unit vector in plan); `right` is the
 * viewer's right hand, so screen-x = p·right and screen-y = z.
 */
import type { ElevationDir, OpenView, SectionDef, SectionBoxBounds } from './viewTypes.ts';
import type { GridData, Level } from '../types.ts';

export type P2 = { x: number; y: number };

/** Clip plane in plan terms: keeps points where nx*x + ny*y + nz*z + c >= 0. */
export interface ModelPlane { nx: number; ny: number; nz: number; c: number }

export interface ViewFrame {
  dir: P2;
  right: P2;
  /** Planes that trim the model (sections only). */
  planes: ModelPlane[];
  /** Screen-x range the view is cropped to (sections), or null = fit the model. */
  crop: [number, number] | null;
  /** Depth (p·dir) of the cut line; elevations: null. */
  cutDepth: number | null;
}

const dot = (a: P2, b: P2) => a.x * b.x + a.y * b.y;

/** Unit vectors for a section line: along the line (`right`) and the view direction (`dir`, its left normal). */
export function sectionFrame(start: P2, end: P2): { right: P2; dir: P2; length: number } | null {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const right = { x: dx / length, y: dy / length };
  return { right, dir: { x: -right.y, y: right.x }, length };
}

/** "North elevation" shows the north façade: the viewer stands north, looking south. */
export const ELEVATION_DIRS: Record<ElevationDir, P2> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: -1, y: 0 },
  west: { x: 1, y: 0 },
};

/** Viewer's right hand for a horizontal view direction. */
export const rightOf = (d: P2): P2 => ({ x: d.y, y: -d.x });

export function viewFrame(view: OpenView, sections: SectionDef[]): ViewFrame | null {
  if (view.kind === 'elevation') {
    const dir = ELEVATION_DIRS[view.dir];
    return { dir, right: rightOf(dir), planes: [], crop: null, cutDepth: null };
  }
  const s = sections.find(x => x.id === view.id);
  if (!s) return null;
  const f = sectionFrame(s.start, s.end);
  if (!f) return null;
  const { dir, right } = f;
  const d0 = dot(s.start, dir);
  const r0 = dot(s.start, right);
  const r1 = dot(s.end, right);
  const planes: ModelPlane[] = [
    { nx: dir.x, ny: dir.y, nz: 0, c: -d0 },          // behind the cut line is removed
    { nx: right.x, ny: right.y, nz: 0, c: -r0 },      // lateral crop at the line ends
    { nx: -right.x, ny: -right.y, nz: 0, c: r1 },
  ];
  if (s.depth != null && s.depth > 0) planes.push({ nx: -dir.x, ny: -dir.y, nz: 0, c: d0 + s.depth });
  return { dir, right, planes, crop: [r0, r1], cutDepth: d0 };
}

/** three.js world plane (normal, constant) for a plan plane. World = (x, z, -y). */
export function toWorldPlane(p: ModelPlane): { normal: [number, number, number]; constant: number } {
  return { normal: [p.nx, p.nz, -p.ny], constant: p.c };
}

/** Section box → six plan planes (inside kept). */
export function sectionBoxPlanes(b: SectionBoxBounds): ModelPlane[] {
  return [
    { nx: 1, ny: 0, nz: 0, c: -b.minX }, { nx: -1, ny: 0, nz: 0, c: b.maxX },
    { nx: 0, ny: 1, nz: 0, c: -b.minY }, { nx: 0, ny: -1, nz: 0, c: b.maxY },
    { nx: 0, ny: 0, nz: 1, c: -b.minZ }, { nx: 0, ny: 0, nz: -1, c: b.maxZ },
  ];
}

/** World box (three) → plan bounds. */
export function worldBoxToBounds(min: [number, number, number], max: [number, number, number]): SectionBoxBounds {
  return { minX: min[0], maxX: max[0], minY: -max[2], maxY: -min[2], minZ: min[1], maxZ: max[1] };
}

/** Screen-x/depth extents of a plan box seen along `dir`. */
export function projectBounds(b: SectionBoxBounds, right: P2): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) {
    const r = x * right.x + y * right.y;
    lo = Math.min(lo, r); hi = Math.max(hi, r);
  }
  return [lo, hi];
}

export interface LevelLine { id: string; name: string; elevation: number }

/** Levels to annotate, low → high. */
export function levelLines(levels: Level[]): LevelLine[] {
  return [...levels].sort((a, b) => a.elevation - b.elevation)
    .map(l => ({ id: l.id, name: l.name || l.number || l.id, elevation: l.elevation }));
}

export interface GridMark { id: string; number: string; at: number }

/**
 * Grids that read as vertical lines in the view: those roughly parallel to the
 * view direction. `at` is the screen-x where the grid meets the reference depth
 * (cut line for sections, model front for elevations).
 */
export function gridMarks(grids: GridData[], frame: { dir: P2; right: P2 }, refDepth: number): GridMark[] {
  const out: GridMark[] = [];
  for (const g of grids) {
    const gx = g.x2 - g.x1, gy = g.y2 - g.y1;
    const len = Math.hypot(gx, gy);
    if (len < 1e-6) continue;
    const u = { x: gx / len, y: gy / len };
    const along = dot(u, frame.dir);
    if (Math.abs(along) < 0.7) continue;
    const a = { x: g.x1, y: g.y1 };
    const t = (refDepth - dot(a, frame.dir)) / along;
    const p = { x: a.x + u.x * t, y: a.y + u.y * t };
    out.push({ id: g.id, number: g.number, at: dot(p, frame.right) });
  }
  return out.sort((m, n) => m.at - n.at);
}

/** Format an elevation for a level head: "±0.000", "+3.600", "-1.200". */
export function formatLevelElevation(z: number): string {
  if (Math.abs(z) < 0.0005) return '±0.000';
  return (z > 0 ? '+' : '') + z.toFixed(3);
}
