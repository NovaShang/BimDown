/**
 * Vertical shafts: polygon openings with a top_level_id cut every slab /
 * structure_slab / roof whose body overlaps their height range, on any level.
 */
import type { GeometryContext } from './archetypes.ts';
import type { Point, PolygonElement } from '../model/elements.ts';
import { isShaft, shaftRange, type CrossLevelEntry } from '../model/crossLevel.ts';

const bboxOf = (pts: Point[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};

/** Shaft outlines cutting a body spanning [z0, z1] (absolute) over `outline`. */
export function shaftHolesFor(ctx: GeometryContext, z0: number, z1: number, outline: Point[]): Point[][] {
  let entries: CrossLevelEntry[];
  let elevations: Map<string, number>;
  if (ctx.crossLevel) {
    entries = ctx.crossLevel.shafts;
    elevations = ctx.crossLevel.elevations;
  } else {
    entries = ctx.elementsByTable('opening').filter(isShaft)
      .map(el => ({ el, levelId: ctx.level.id, elevation: ctx.levelElevation }));
    elevations = ctx.levelElevations;
  }
  if (entries.length === 0) return [];
  const box = bboxOf(outline);
  const out: Point[][] = [];
  for (const e of entries) {
    if (e.el.geometry !== 'polygon') continue;
    const vs = (e.el as PolygonElement).vertices;
    if (vs.length < 3) continue;
    const r = shaftRange(e, elevations);
    if (!r || r[0] >= z1 - 1e-6 || r[1] <= z0 + 1e-6) continue;
    const b = bboxOf(vs);
    if (b.minX > box.maxX || b.maxX < box.minX || b.minY > box.maxY || b.maxY < box.minY) continue;
    out.push(vs);
  }
  return out;
}
