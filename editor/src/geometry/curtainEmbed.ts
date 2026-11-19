/**
 * Curtain walls embedded in walls (Revit "Automatically Embed"; spec readme
 * "Curtain Wall Grids and Panels"): a curtain wall lying along a wall — both
 * straight and parallel, or both arcs on the same centre, its line inside the
 * wall's thickness — cuts a void the length of the overlap and the height of
 * the curtain wall out of that wall. Derived, not stored: moving or deleting
 * the curtain wall updates its host. The CLI keeps a verbatim copy in
 * bimdown-spec/cli/src/curtain-embed.ts (web/src/lib/shared-code-drift.test.ts).
 */
interface P { x: number; y: number }
/** Circular arc of a line (editor ArcParams `rx` / `largeArc`, or GeoJSON `radius` / `large_arc`), SVG-A semantics. */
export interface EmbedArc { rx?: number; radius?: number; largeArc?: boolean; large_arc?: boolean; sweep: boolean }
export interface EmbedLine { start: P; end: P; arc?: EmbedArc | null }

/** Overlap of a curtain wall with a host wall, as distances from the wall start (along the arc for arc walls). */
export interface EmbedSpan { lo: number; hi: number }

/** Sine of the largest angle (≈1.2°) between a wall and a curtain wall still treated as parallel. */
const PARALLEL_SIN = 0.02;
const TAU = 2 * Math.PI;

/** Centre, radius, start angle and signed sweep (radians, + = counter-clockwise) of an arc line. */
export interface EmbedCircle { cx: number; cy: number; r: number; a0: number; sweep: number }

/** The circle of an arc line (SVG F.6.5 without rotation), null for a straight line. */
export function embedCircle(line: EmbedLine): EmbedCircle | null {
  const arc = line.arc;
  if (!arc) return null;
  let r = Math.abs(arc.rx ?? arc.radius ?? 0);
  const large = !!(arc.largeArc ?? arc.large_arc);
  const x1p = (line.start.x - line.end.x) / 2, y1p = (line.start.y - line.end.y) / 2;
  const d2 = x1p * x1p + y1p * y1p;
  if (d2 < 1e-18) return null;
  if (r * r < d2) r = Math.sqrt(d2);
  let sq = Math.sqrt(Math.max(0, (r * r - d2) / d2));
  if (large === !!arc.sweep) sq = -sq;
  const cx = sq * y1p + (line.start.x + line.end.x) / 2;
  const cy = -sq * x1p + (line.start.y + line.end.y) / 2;
  const a0 = Math.atan2(line.start.y - cy, line.start.x - cx);
  let sweep = Math.atan2(line.end.y - cy, line.end.x - cx) - a0;
  if (arc.sweep && sweep <= 0) sweep += TAU;
  if (!arc.sweep && sweep >= 0) sweep -= TAU;
  return { cx, cy, r, a0, sweep };
}

/** Length of a wall / curtain wall line (arc length for arcs). */
export function embedLength(line: EmbedLine): number {
  const c = embedCircle(line);
  return c ? c.r * Math.abs(c.sweep) : Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
}

/** Point at distance `s` from the start along a (straight or arc) line. */
export function embedPointAt(line: EmbedLine, s: number): P {
  const c = embedCircle(line);
  if (c) {
    const a = c.a0 + Math.sign(c.sweep) * s / c.r;
    return { x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) };
  }
  const l = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) || 1;
  return { x: line.start.x + (line.end.x - line.start.x) * s / l, y: line.start.y + (line.end.y - line.start.y) * s / l };
}

/**
 * Where `cw` embeds in `wall` (`thickness` = the wall's), or null: both
 * straight and parallel, or both arcs on one centre. `tol` is a length
 * tolerance in project units (a few mm).
 */
export function curtainEmbedSpan(wall: EmbedLine, thickness: number, cw: EmbedLine, tol: number): EmbedSpan | null {
  if (!!wall.arc !== !!cw.arc) return null;
  if (wall.arc) return arcEmbedSpan(wall, thickness, cw, tol);
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  const cdx = cw.end.x - cw.start.x, cdy = cw.end.y - cw.start.y;
  const clen = Math.hypot(cdx, cdy);
  if (len < tol || clen < tol) return null;
  const ux = dx / len, uy = dy / len;
  if (Math.abs(ux * cdy - uy * cdx) / clen > PARALLEL_SIN) return null;
  const half = thickness / 2 + tol;
  const across = (p: P) => Math.abs(-(p.x - wall.start.x) * uy + (p.y - wall.start.y) * ux);
  if (across(cw.start) > half || across(cw.end) > half) return null;
  const along = (p: P) => (p.x - wall.start.x) * ux + (p.y - wall.start.y) * uy;
  const a = along(cw.start), b = along(cw.end);
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(len, Math.max(a, b));
  return hi - lo > tol ? { lo, hi } : null;
}

/** Arc curtain wall on an arc wall: one centre, its radius inside the thickness; the angular overlap. */
function arcEmbedSpan(wall: EmbedLine, thickness: number, cw: EmbedLine, tol: number): EmbedSpan | null {
  const w = embedCircle(wall), c = embedCircle(cw);
  if (!w || !c) return null;
  const half = thickness / 2 + tol;
  if (Math.hypot(w.cx - c.cx, w.cy - c.cy) > half || Math.abs(w.r - c.r) > half) return null;
  const dir = Math.sign(w.sweep);
  // Angle from the wall start in the wall's direction, in [0, 2π)
  const t0 = (((c.a0 - w.a0) * dir) % TAU + TAU) % TAU;
  const t1 = t0 + Math.abs(c.sweep) * (Math.sign(c.sweep) === dir ? 1 : -1);
  let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  // Of the interval and its copy one turn back, keep the one overlapping the wall most.
  const wl = Math.abs(w.sweep);
  const overlap = (a: number, b: number) => Math.max(0, Math.min(wl, b) - Math.max(0, a));
  if (overlap(lo - TAU, hi - TAU) > overlap(lo, hi)) { lo -= TAU; hi -= TAU; }
  const sLo = Math.max(0, lo) * w.r, sHi = Math.min(wl, hi) * w.r;
  return sHi - sLo > tol ? { lo: sLo, hi: sHi } : null;
}

/** Vertical span of a curtain wall: base offset from its level and height (same rule as its 3D). */
export function curtainWallSpan(
  attrs: Record<string, string>, levelElevation: number, levelElevations: Map<string, number>, defaultHeight = 3,
): { height: number; baseOffset: number } {
  const baseOffset = parseFloat(attrs.base_offset || '0') || 0;
  const topLevelId = attrs.top_level_id;
  if (topLevelId && levelElevations.has(topLevelId)) {
    const topOff = parseFloat(attrs.top_offset || '0') || 0;
    return { height: Math.max(0.01, levelElevations.get(topLevelId)! + topOff - (levelElevation + baseOffset)), baseOffset };
  }
  return { height: defaultHeight, baseOffset };
}
