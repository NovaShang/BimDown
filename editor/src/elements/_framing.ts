/**
 * Beam ↔ column plan relations: column footprints, trimming a beam's plan
 * drawing at the column faces, and finding which column a beam end frames
 * into (for "beams follow a moved column").
 */
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import type { GeometryContext } from './archetypes.ts';
import { resolveSection } from '../families/sections/index.ts';

export const COLUMN_TABLES = ['structure_column', 'column'] as const;

/** Plan footprint of a column: centre, rotation, half sizes (local frame). */
export interface ColumnFootprint {
  id: string;
  center: Point;
  /** Rotation, radians CCW. */
  rot: number;
  hw: number;
  hh: number;
  round: boolean;
}

export function columnFootprint(el: CanonicalElement): ColumnFootprint | null {
  if (el.geometry !== 'point') return null;
  const p = el as PointElement;
  const attrs = {
    ...p.attrs,
    size_x: p.attrs.size_x || String(p.width || 0.3),
    size_y: p.attrs.size_y || String(p.height || p.width || 0.3),
  };
  const section = resolveSection(p.attrs.shape || 'rect', attrs);
  const bb = section.family.bbox(section.params);
  return {
    id: p.id,
    center: p.position,
    rot: ((parseFloat(p.attrs.rotation || '0') || 0) * Math.PI) / 180,
    hw: bb.w / 2,
    hh: bb.d / 2,
    round: section.family.id === 'round',
  };
}

/** All column footprints in the geometry context (memoized per render pass). */
export function columnFootprints(ctx: GeometryContext): ColumnFootprint[] {
  return ctx.memo('framing:columnFootprints', () => {
    const out: ColumnFootprint[] = [];
    for (const t of COLUMN_TABLES) {
      for (const el of ctx.elementsByTable(t)) {
        const fp = columnFootprint(el);
        if (fp) out.push(fp);
      }
    }
    return out;
  });
}

function toLocal(fp: ColumnFootprint, p: Point): Point {
  const dx = p.x - fp.center.x, dy = p.y - fp.center.y;
  const c = Math.cos(-fp.rot), s = Math.sin(-fp.rot);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Whether `p` lies inside the column footprint grown by `tol`. */
export function insideFootprint(fp: ColumnFootprint, p: Point, tol = 0): boolean {
  const l = toLocal(fp, p);
  if (fp.round) return Math.hypot(l.x, l.y) <= fp.hw + tol;
  return Math.abs(l.x) <= fp.hw + tol && Math.abs(l.y) <= fp.hh + tol;
}

/** Parameter interval [tIn, tOut] where the line a + t(b − a) lies inside the
 *  footprint, or null when it misses. */
function lineInterval(fp: ColumnFootprint, a: Point, b: Point): [number, number] | null {
  const la = toLocal(fp, a), lb = toLocal(fp, b);
  const dx = lb.x - la.x, dy = lb.y - la.y;
  if (fp.round) {
    const r = fp.hw;
    const A = dx * dx + dy * dy;
    if (A < 1e-12) return null;
    const B = 2 * (la.x * dx + la.y * dy);
    const C = la.x * la.x + la.y * la.y - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  }
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d, h] of [[la.x, dx, fp.hw], [la.y, dy, fp.hh]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p) > h) return null;
      continue;
    }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/**
 * Parameters [t0, t1] (0..1 along start→end) of the visible part of a beam in
 * plan: an end that lies inside a column stops at that column's face.
 */
export function trimAtColumns(start: Point, end: Point, columns: ColumnFootprint[]): [number, number] {
  let t0 = 0, t1 = 1;
  for (const fp of columns) {
    // Cheap reject: endpoints far from the column.
    const reach = Math.max(fp.hw, fp.hh) * 1.5 + 0.01;
    const nearStart = Math.hypot(start.x - fp.center.x, start.y - fp.center.y) <= reach;
    const nearEnd = Math.hypot(end.x - fp.center.x, end.y - fp.center.y) <= reach;
    if (!nearStart && !nearEnd) continue;
    const iv = lineInterval(fp, start, end);
    if (!iv) continue;
    if (nearStart && iv[0] <= 1e-9 && iv[1] >= 0) t0 = Math.max(t0, iv[1]);
    if (nearEnd && iv[1] >= 1 - 1e-9 && iv[0] <= 1) t1 = Math.min(t1, iv[0]);
  }
  if (t1 - t0 < 1e-3) return [0, 1]; // fully inside one column: draw it whole
  return [t0, t1];
}

/** A beam's plan centre line and half width, for trimming the beams framing into it. */
export interface BeamSegment {
  id: string;
  start: Point;
  end: Point;
  /** Half the plan width of the section. */
  hw: number;
  /** Mean top z (level-relative): beams at another height do not trim. */
  z: number;
  /** Section depth. */
  depth: number;
}

/** All beams of the geometry context as segments (memoized per render pass). */
export function beamSegments(ctx: GeometryContext): BeamSegment[] {
  return ctx.memo('framing:beamSegments', () => {
    const out: BeamSegment[] = [];
    for (const el of ctx.elementsByTable('beam')) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const section = resolveSection(el.attrs.shape || 'rect', el.attrs);
      const bb = section.family.bbox(section.params);
      const z = el.geometry === 'spatial_line' ? (el.startZ + el.endZ) / 2 : parseFloat(el.attrs.base_offset || '0') || 0;
      out.push({ id: el.id, start: el.start, end: el.end, hw: bb.w / 2, z, depth: bb.d });
    }
    return out;
  });
}

/**
 * Parameters [t0, t1] of a secondary beam trimmed at the faces of the
 * primary beams it frames into: an end lying on another beam's centre line,
 * inside that beam's span (not at its ends), stops at its side face, as
 * Revit joins infill beams to girders. Beams at another height are ignored.
 */
export function trimAtBeams(id: string, start: Point, end: Point, z: number, beams: BeamSegment[]): [number, number] {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [0, 1];
  const ux = dx / len, uy = dy / len;
  let t0 = 0, t1 = 1;
  for (const b of beams) {
    if (b.id === id || Math.abs(b.z - z) > Math.max(b.depth, 0.05)) continue;
    const bx = b.end.x - b.start.x, by = b.end.y - b.start.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) continue;
    const vx = bx / bl, vy = by / bl;
    const sin = Math.abs(ux * vy - uy * vx);
    if (sin < 0.2) continue; // (nearly) parallel: a continuation, not a join
    for (const [p, atStart] of [[start, true], [end, false]] as const) {
      const wx = p.x - b.start.x, wy = p.y - b.start.y;
      const along = wx * vx + wy * vy;
      const off = Math.abs(wx * vy - wy * vx);
      // On the centre line (within the half width) and strictly inside the span
      if (off > b.hw + 0.01 || along <= b.hw + 0.01 || along >= bl - b.hw - 0.01) continue;
      const cut = (b.hw / sin) / len;
      if (atStart) t0 = Math.max(t0, cut); else t1 = Math.min(t1, 1 - cut);
    }
  }
  return t1 - t0 < 1e-3 ? [0, 1] : [t0, t1];
}

/** Id of the column whose footprint holds `p` (centre within tolerance first). */
export function columnAt(p: Point, columns: ColumnFootprint[], tol = 0.01): ColumnFootprint | null {
  let best: ColumnFootprint | null = null;
  let bestD = Infinity;
  for (const fp of columns) {
    if (!insideFootprint(fp, p, tol)) continue;
    const d = Math.hypot(p.x - fp.center.x, p.y - fp.center.y);
    if (d < bestD) { best = fp; bestD = d; }
  }
  return best;
}
