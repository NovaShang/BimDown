/**
 * Copy of bimdown-editor/editor/src/geometry/curtainEmbed.ts (verbatim; web/src/lib/shared-code-drift.test.ts).
 */
/**
 * Curtain walls embedded in walls (Revit "Automatically Embed"; spec readme
 * "Curtain Wall Grids and Panels"): a straight curtain wall lying along a
 * straight wall — parallel, its line inside the wall's thickness — cuts a
 * void the length of the overlap and the height of the curtain wall out of
 * that wall. Derived, not stored: moving or deleting the curtain wall
 * updates its host. The CLI keeps a verbatim copy in
 * bimdown-spec/cli/src/curtain-embed.ts (web/src/lib/shared-code-drift.test.ts).
 */
interface P { x: number; y: number }
export interface EmbedLine { start: P; end: P }

/** Overlap of a curtain wall with a host wall, as distances from the wall start. */
export interface EmbedSpan { lo: number; hi: number }

/** Sine of the largest angle (≈1.2°) between a wall and a curtain wall still treated as parallel. */
const PARALLEL_SIN = 0.02;

/**
 * Where `cw` embeds in `wall` (both straight; `thickness` = the wall's), or
 * null. `tol` is a length tolerance in project units (a few mm).
 */
export function curtainEmbedSpan(wall: EmbedLine, thickness: number, cw: EmbedLine, tol: number): EmbedSpan | null {
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
