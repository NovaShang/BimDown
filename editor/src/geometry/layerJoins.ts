/**
 * Fine-detail joins of layered walls in plan (Revit's "core joins core"): a
 * wall teeing into a layered wall runs through that wall's finish layers on
 * its side and stops on its core. The main wall's finish layers are cut away
 * over the stem's width, the stem's sides continue to the core face.
 *
 * Offsets are signed along a wall's left normal (+ = left = exterior side),
 * like geometry/layerBands.ts.
 */
import type { Point } from '../model/elements.ts';
import type { LayerBand } from './layerBands.ts';

export interface JoinWall {
  id: string;
  start: Point;
  end: Point;
  thickness: number;
  /** Type layer bands (straight layered walls); undefined = one material. */
  bands?: LayerBand[];
}

export interface JoinTee {
  tWallId: string;
  tWhich: 'start' | 'end';
  mainWallId: string;
}

/** Part of a main wall's finish taken by a stem: along [a0, a1] (from its start), offsets [lo, hi]. */
export interface FinishCut {
  a0: number;
  a1: number;
  lo: number;
  hi: number;
}

export interface StemEnd {
  /** Corner adjustment for the stem's end (left / right as in miter.ts) at the core face. */
  left: Point;
  right: Point;
  /** The stem's sides from the main wall's face to its core face, and its end on the core. */
  lines: [Point, Point][];
}

export interface FineJoins {
  /** Keyed `${stemId}:${which}`. */
  stems: Map<string, StemEnd>;
  /** Keyed by main wall id. */
  cuts: Map<string, FinishCut[]>;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

function rayLine(p: Point, d: Point, q: Point, e: Point): Point | null {
  const det = e.x * d.y - d.x * e.y;
  if (Math.abs(det) < 1e-12) return null;
  const t = (e.x * (q.y - p.y) - e.y * (q.x - p.x)) / det;
  return { x: p.x + t * d.x, y: p.y + t * d.y };
}

/** Core face of a layered wall on `side` (+1 left, −1 right); the face itself when it has no core. */
export function coreFace(w: JoinWall, side: 1 | -1): number {
  const half = w.thickness / 2;
  const core = (w.bands ?? []).filter(b => b.function === 'core');
  if (core.length === 0) return side * half;
  return side > 0 ? Math.max(...core.map(b => b.hi)) : Math.min(...core.map(b => b.lo));
}

/**
 * Joins for every tee whose main wall is straight and layered with a core:
 * where the stem stops (core face) and what it takes out of the main wall.
 */
export function fineJoins(walls: ReadonlyMap<string, JoinWall>, tees: readonly JoinTee[]): FineJoins {
  const out: FineJoins = { stems: new Map(), cuts: new Map() };
  for (const tj of tees) {
    const m = walls.get(tj.mainWallId), s = walls.get(tj.tWallId);
    if (!m || !s || !m.bands) continue;
    const md = sub(m.end, m.start);
    const ml = Math.hypot(md.x, md.y);
    if (ml < 1e-9) continue;
    const mu = { x: md.x / ml, y: md.y / ml };
    const mn = { x: -mu.y, y: mu.x };
    const ep = tj.tWhich === 'start' ? s.start : s.end;
    const far = tj.tWhich === 'start' ? s.end : s.start;
    const away = sub(far, ep);
    const al = Math.hypot(away.x, away.y);
    if (al < 1e-9) continue;
    const su = { x: away.x / al, y: away.y / al };
    // Which side of the main wall the stem comes from
    const sideDot = su.x * mn.x + su.y * mn.y;
    if (Math.abs(sideDot) < 0.2) continue; // grazing: no clean pass-through
    const side: 1 | -1 = sideDot > 0 ? 1 : -1;
    const face = side * m.thickness / 2;
    const core = coreFace(m, side);
    if (Math.abs(face - core) < 1e-6) continue;
    const sn = { x: -su.y, y: su.x };
    const hw = s.thickness / 2;
    const sl = { x: ep.x + sn.x * hw, y: ep.y + sn.y * hw };
    const sr = { x: ep.x - sn.x * hw, y: ep.y - sn.y * hw };
    const at = (off: number): Point => ({ x: m.start.x + mn.x * off, y: m.start.y + mn.y * off });
    const left = rayLine(sl, su, at(core), mu), right = rayLine(sr, su, at(core), mu);
    const fl = rayLine(sl, su, at(face), mu), fr = rayLine(sr, su, at(face), mu);
    if (!left || !right || !fl || !fr) continue;
    out.stems.set(`${s.id}:${tj.tWhich}`, { left, right, lines: [[fl, left], [fr, right], [left, right]] });
    const along = (p: Point) => (p.x - m.start.x) * mu.x + (p.y - m.start.y) * mu.y;
    const ts = [left, right, fl, fr].map(along);
    const cut: FinishCut = {
      a0: Math.min(...ts), a1: Math.max(...ts),
      lo: Math.min(face, core), hi: Math.max(face, core),
    };
    const list = out.cuts.get(m.id);
    if (list) list.push(cut); else out.cuts.set(m.id, [cut]);
  }
  return out;
}

/** Half-plane clip: keep points with sign·(along(p) − a) ≥ 0. */
function clipAlong(poly: Point[], origin: Point, u: Point, a: number, sign: 1 | -1): Point[] {
  const along = (p: Point) => sign * ((p.x - origin.x) * u.x + (p.y - origin.y) * u.y - a);
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = along(p), dq = along(q);
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

/** `poly` (a layer band piece of the main wall) minus the parts along the cuts covering [lo, hi]. */
export function cutBand(poly: Point[], start: Point, end: Point, lo: number, hi: number, cuts: readonly FinishCut[]): Point[][] {
  const d = sub(end, start), l = Math.hypot(d.x, d.y);
  if (l < 1e-9) return [poly];
  const u = { x: d.x / l, y: d.y / l };
  let pieces = [poly];
  for (const c of cuts) {
    if (lo < c.lo - 1e-9 || hi > c.hi + 1e-9) continue; // band not in this finish zone
    const next: Point[][] = [];
    for (const p of pieces) {
      const before = clipAlong(p, start, u, c.a0, -1);
      const after = clipAlong(p, start, u, c.a1, 1);
      if (before.length >= 3) next.push(before);
      if (after.length >= 3) next.push(after);
    }
    pieces = next;
  }
  return pieces;
}

/** A chord of the main wall at offset `off`, minus the stems crossing it (strictly inside a finish zone or on the core face). */
export function cutChord(chord: [Point, Point], start: Point, end: Point, off: number, cuts: readonly FinishCut[]): [Point, Point][] {
  const d = sub(end, start), l = Math.hypot(d.x, d.y);
  if (l < 1e-9) return [chord];
  const u = { x: d.x / l, y: d.y / l };
  const along = (p: Point) => (p.x - start.x) * u.x + (p.y - start.y) * u.y;
  let pieces: [number, number][] = [[along(chord[0]), along(chord[1])].sort((a, b) => a - b) as [number, number]];
  for (const c of cuts) {
    if (off < c.lo - 1e-9 || off > c.hi + 1e-9) continue;
    const next: [number, number][] = [];
    for (const [a, b] of pieces) {
      if (c.a0 > a) next.push([a, Math.min(b, c.a0)]);
      if (c.a1 < b) next.push([Math.max(a, c.a1), b]);
    }
    pieces = next.filter(([a, b]) => b - a > 1e-6);
  }
  const p0 = chord[0], p1 = chord[1];
  const a0 = along(p0), span = along(p1) - a0;
  const at = (a: number): Point => {
    const t = Math.abs(span) < 1e-12 ? 0 : (a - a0) / span;
    return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  };
  return pieces.map(([a, b]) => [at(a), at(b)]);
}
