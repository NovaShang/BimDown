/**
 * Rendered elevations (Revit "surface patterns" + "cast shadows"): the faces
 * of walls, roofs, curtain walls, doors and windows that look at the viewer
 * get a light material tint, brick coursing / roof tile lines, and the
 * shadows nearer geometry casts on them under a 45° / 45° sun from the upper
 * left (eaves on the façade, reveals in window and door openings).
 *
 * Painter's order: every face triangle is filled at its depth, far first;
 * a shadow piece (the occluder triangle moved by its depth gap, clipped to
 * the receiving triangle) sits just in front of its receiver, so anything
 * nearer still covers it. The line work (hidden-line removed) is drawn over
 * all of it by the caller.
 */
import type { Point } from '../../model/elements.ts';
import type { DrawItem } from './types.ts';
import type { ViewPart } from './viewSolids.ts';

export interface ViewPoint { u: number; v: number; d: number }

/** Light tints per material (fills stay under the line work). */
const TINT: Record<string, string> = {
  brick: '#ecd3c3', concrete: '#e6e6e3', stone: '#e8e2d6', wood: '#ecdcc4', clt: '#ecdcc4',
  glass: '#d6e7f1', aluminum: '#e1e5e8', steel: '#dde1e4', gypsum: '#f2f0ea', insulation: '#f1efde',
  composite: '#f1efe9', fiber_cement: '#e9e7e1', ceramic: '#efe6df', copper: '#e7d2c0', pvc: '#f2f2f2',
};
const DEFAULT_TINT = '#efefec';
const ROOF_TINT = '#ddd6d0';

/** Brick courses (m) and roof tile rows (m, along the view's vertical). */
const BRICK_COURSE = 0.075;
const TILE_ROW = 0.3;

/** Sun: shadows fall right and down by the depth gap (45° in plan and in elevation). */
const SHADOW_K = 1;
const MIN_GAP_M = 0.03;
const MAX_GAP_M = 4;
/** Above this many faces the elevation is drawn without shadows (time). */
const MAX_SHADOW_FACES = 8000;

const SURFACE_CLS = new Set(['wall', 'swall', 'roof', 'curtain', 'glass', 'door', 'window', 'slab', 'sslab', 'column', 'scolumn', 'beam', 'stair', 'railing']);
const RECEIVER_CLS = new Set(['wall', 'swall', 'curtain', 'glass', 'door', 'window', 'roof', 'column', 'scolumn']);

interface Face {
  pts: Point[];
  d: number;
  color: string;
  hatch: 'brick' | 'tile' | null;
  receiver: boolean;
  box: [number, number, number, number];
}

function darken(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(v * k));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function faceMaterial(part: ViewPart, nx: number, ny: number): string {
  if (part.cls === 'glass') return 'glass';
  if (part.cls === 'curtain') return 'aluminum';
  const fm = part.faceMaterials;
  if (fm) return nx * -fm.axis.y + ny * fm.axis.x >= 0 ? fm.left : fm.right;
  return part.material ?? '';
}

/** Polygon clipped to a convex polygon (Sutherland–Hodgman). */
export function clipConvex(subject: Point[], clip: Point[]): Point[] {
  let out = subject;
  const ccw = signedArea(clip) > 0;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: Point) => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) * (ccw ? 1 : -1) >= -1e-12;
    const cut = (p: Point, q: Point): Point => {
      // p + t (q − p) on the line a–b: t = (a − p) × (b − a) / (q − p) × (b − a)
      const dx = q.x - p.x, dy = q.y - p.y, ex = b.x - a.x, ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      const t = Math.abs(den) < 1e-15 ? 0 : Math.min(1, Math.max(0, ((a.x - p.x) * ey - (a.y - p.y) * ex) / den));
      return { x: p.x + dx * t, y: p.y + dy * t };
    };
    const src = out;
    out = [];
    for (let j = 0; j < src.length; j++) {
      const cur = src[j], prev = src[(j + src.length - 1) % src.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
  }
  return out;
}

function signedArea(p: Point[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return a / 2;
}

const boxOf = (pts: Point[]): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return [x0, y0, x1, y1];
};

/** Horizontal lines every `step` (from 0) across a triangle. */
function hatchLines(pts: Point[], step: number): [Point, Point][] {
  const out: [Point, Point][] = [];
  const [, y0, , y1] = boxOf(pts);
  for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
    }
    if (xs.length >= 2) out.push([{ x: Math.min(...xs), y }, { x: Math.max(...xs), y }]);
  }
  return out;
}

export interface SurfaceOptions {
  upm: number;
  /** Model units per paper mm. */
  pm: number;
  fillLayer: string;
  hatchLayer: string;
  shadowLayer: string;
  shadows?: boolean;
}

/** Fill, hatch and shadow items of the faces looking at the viewer, far first. */
export function elevationSurfaces(parts: ViewPart[], project: (x: number, y: number, z: number) => ViewPoint, dir: { x: number; y: number }, o: SurfaceOptions): DrawItem[] {
  const faces: Face[] = [];
  for (const part of parts) {
    if (!SURFACE_CLS.has(part.cls)) continue;
    const t = part.tris;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const ax = t[i], ay = t[i + 1], az = t[i + 2], bx = t[i + 3], by = t[i + 4], bz = t[i + 5], cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
      // Normal; faces looking back at the viewer only (n · view dir < 0)
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      const facing = -(nx * dir.x + ny * dir.y) / nl;
      if (facing < 0.05) continue;
      const P = [project(ax, ay, az), project(bx, by, bz), project(cx, cy, cz)];
      const pts = P.map(p => ({ x: p.u, y: p.v }));
      if (Math.abs(signedArea(pts)) < 1e-10 * o.upm * o.upm) continue;
      const roof = part.cls === 'roof';
      const mat = faceMaterial(part, nx / nl, ny / nl);
      const base = roof && (!mat || mat === 'concrete') ? ROOF_TINT : TINT[mat] ?? DEFAULT_TINT;
      // Slightly darker the more the face turns away (reads the massing)
      const color = facing > 0.98 ? base : darken(base, 0.93 + 0.07 * facing);
      const hatch = roof && nz / nl > 0.1 ? 'tile' : mat === 'brick' ? 'brick' : null;
      faces.push({ pts, d: (P[0].d + P[1].d + P[2].d) / 3, color, hatch, receiver: RECEIVER_CLS.has(part.cls), box: boxOf(pts) });
    }
  }
  if (faces.length === 0) return [];

  type Item = { d: number; item: DrawItem };
  const items: Item[] = [];
  for (const f of faces) items.push({ d: f.d, item: { kind: 'path', layer: o.fillLayer, pts: f.pts, closed: true, fill: f.color, noStroke: true } });

  // Coursing: brick every course when it prints ≥ 0.6 mm apart, else every 4th; tile rows
  for (const f of faces) {
    if (!f.hatch) continue;
    let step = (f.hatch === 'brick' ? BRICK_COURSE : TILE_ROW) * o.upm;
    if (step / o.pm < 0.6) step *= 4;
    if (step / o.pm < 0.6) continue;
    for (const [a, b] of hatchLines(f.pts, step)) items.push({ d: f.d - 2e-4 * o.upm, item: { kind: 'path', layer: o.hatchLayer, pts: [a, b], closed: false } });
  }

  // Cast shadows: occluder triangle moved by the depth gap, clipped to each receiver behind it
  if (o.shadows !== false && faces.length <= MAX_SHADOW_FACES) {
    const cell = 1 * o.upm;
    const grid = new Map<string, number[]>();
    faces.forEach((f, i) => {
      if (!f.receiver) return;
      for (let gx = Math.floor(f.box[0] / cell); gx <= Math.floor(f.box[2] / cell); gx++) {
        for (let gy = Math.floor(f.box[1] / cell); gy <= Math.floor(f.box[3] / cell); gy++) {
          const k = `${gx},${gy}`;
          const l = grid.get(k);
          if (l) l.push(i); else grid.set(k, [i]);
        }
      }
    });
    const minGap = MIN_GAP_M * o.upm, maxGap = MAX_GAP_M * o.upm;
    for (const occ of faces) {
      // Candidate receivers: anything the moved triangle can reach (up to the largest gap)
      const reach = maxGap * SHADOW_K;
      const seen = new Set<number>();
      for (let gx = Math.floor(occ.box[0] / cell); gx <= Math.floor((occ.box[2] + reach) / cell); gx++) {
        for (let gy = Math.floor((occ.box[1] - reach) / cell); gy <= Math.floor(occ.box[3] / cell); gy++) {
          for (const ri of grid.get(`${gx},${gy}`) ?? []) {
            if (seen.has(ri)) continue;
            seen.add(ri);
            const rec = faces[ri];
            const gap = rec.d - occ.d;
            if (gap < minGap || gap > maxGap) continue;
            const s = gap * SHADOW_K;
            const moved = occ.pts.map(p => ({ x: p.x + s, y: p.y - s }));
            const mb = boxOf(moved);
            if (mb[0] > rec.box[2] || mb[2] < rec.box[0] || mb[1] > rec.box[3] || mb[3] < rec.box[1]) continue;
            const piece = clipConvex(moved, rec.pts);
            if (piece.length < 3 || Math.abs(signedArea(piece)) < 1e-8 * o.upm * o.upm) continue;
            items.push({ d: rec.d - 1e-4 * o.upm, item: { kind: 'path', layer: o.shadowLayer, pts: piece, closed: true, fill: darken(rec.color, 0.72), noStroke: true } });
          }
        }
      }
    }
  }
  items.sort((a, b) => b.d - a.d);
  return items.map(i => i.item);
}
