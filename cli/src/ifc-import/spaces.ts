/**
 * IfcSpace → space seed point (inside the space's footprint) with name and
 * number. The IFC outline and its area are kept for the room comparison and for
 * placing room separators where the space has no wall.
 */
import type { ImportContext, OutEl } from './context.js';
import { type Obstacle, type PlanPolygon, footprint, seedPoint } from './geometry.js';
import { endpoints } from './lines.js';
import { str } from './model.js';
import { footprintRings } from './representation.js';
import { polygonArea, r3 } from './math.js';

export interface SpaceRef {
  el: OutEl;
  /** IFC space outline in plan (largest piece). */
  outline: PlanPolygon;
  /** Area of the IFC floor outline (at the finish faces, like BimDown net_area). */
  ifcArea: number;
}

/** Walls of each level as seed obstacles. */
export function wallObstacles(ctx: ImportContext): Map<number, Obstacle[]> {
  const out = new Map<number, Obstacle[]>();
  for (const el of ctx.out) {
    if (!WALLS.has(el.table) || el.geometry?.type !== 'LineString') continue;
    const [a, b] = endpoints(el);
    const o = { a, b, half: (ctx.lines.get(el)?.thickness ?? 0) / 2 };
    const list = out.get(el.level);
    if (list) list.push(o); else out.set(el.level, [o]);
  }
  return out;
}

const WALLS = new Set(['wall', 'structure_wall', 'curtain_wall']);

export function convertSpace(ctx: ImportContext, id: number, obstacles: Map<number, Obstacle[]>): SpaceRef | null {
  const { model } = ctx;
  const mesh = ctx.mesh(id);
  let outline: PlanPolygon | undefined;
  let zMin: number;
  if (mesh) {
    // The floor outline: triangles near the bottom (sloped ceilings don't widen it)
    const polys = footprint(mesh, 0.005, mesh.min.z + 0.05);
    outline = (polys.length ? polys : footprint(mesh))[0];
    zMin = mesh.min.z;
  } else {
    // No body: the FootPrint curve (ArchiCAD exports spaces this way)
    const rings = footprintRings(model, id).map(r => ({ outer: polygonArea(r) < 0 ? r.slice().reverse() : r, holes: [], area: Math.abs(polygonArea(r)) }));
    outline = rings.sort((a, b) => b.area - a.area)[0];
    zMin = model.productMatrix(id)?.[14] ?? 0;
  }
  if (!outline || outline.area < 0.1) { ctx.skip(id, mesh ? 'no plan footprint' : 'no body or footprint geometry'); return null; }
  const level = ctx.levelOf(id, zMin);
  const seed = seedPoint(outline, obstacles.get(level) ?? []);
  const line = model.line(id);
  const name = str(line?.LongName);
  const number = str(line?.Name);
  const el = ctx.add('space', id, level, {
    number: name ? number ?? undefined : undefined,
    name: name ?? number ?? undefined,
    x: r3(seed.x),
    y: r3(seed.y),
  }, null);
  return { el, outline, ifcArea: outline.area };
}
