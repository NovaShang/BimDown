/**
 * Room (space) boundary + area helpers shared by tags, the properties panel
 * and schedules. Boundaries come from the same half-edge derivation the plan
 * uses (geometry/spaceBoundary.ts, a port of `bimdown build`), so outlines
 * match the CLI's space.geojson (wall centre lines). The area shown is the
 * net area at the wall faces (geometry/roomArea.ts, the CLI's `net_area`);
 * the centre-line area is the gross area (the CLI's `area`).
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import { deriveSpaceBoundary, BOUNDARY_TABLES } from '../geometry/spaceBoundary.ts';
import { roomAreas, type RoomAreas } from '../geometry/roomArea.ts';
import { metre } from './geometry.ts';

const BOUNDARY = new Set<string>(BOUNDARY_TABLES);

export function polygonArea(v: Point[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(v: Point[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

export function boundaryWalls(elements: Iterable<CanonicalElement>): LineElement[] {
  const out: LineElement[] = [];
  for (const e of elements) if (BOUNDARY.has(e.tableName) && e.geometry === 'line') out.push(e as LineElement);
  return out;
}

/** Room outline: stored polygon, or derived from the given boundary walls. */
export function roomPolygon(space: CanonicalElement, walls: LineElement[]): Point[] | null {
  if (space.geometry === 'polygon') return space.vertices.length >= 3 ? space.vertices : null;
  if (space.geometry !== 'point') return null;
  const poly = deriveSpaceBoundary(space.position, walls);
  return poly && poly.length >= 3 ? poly : null;
}

/** Net (wall-face) and gross (centre-line) area of a room outline; `walls` are its level's boundary lines. */
export function roomAreasOf(poly: Point[], walls: LineElement[]): RoomAreas {
  return roomAreas(poly, walls, metre());
}

/** The level's boundary lines, memoised per render pass. */
export function boundaryWallsFromCtx(ctx: GeometryContext): LineElement[] {
  return ctx.memo<LineElement[]>('space-boundary:walls', () => {
    const collected: LineElement[] = [];
    for (const table of BOUNDARY_TABLES) {
      for (const e of ctx.elementsByTable(table)) if (e.geometry === 'line') collected.push(e as LineElement);
    }
    return collected;
  });
}

/** Same as roomPolygon, memoised per render pass with the keys the space module uses. */
export function roomPolygonFromCtx(space: CanonicalElement, ctx: GeometryContext): Point[] | null {
  if (space.geometry !== 'point') return roomPolygon(space, []);
  const walls = boundaryWallsFromCtx(ctx);
  const poly = ctx.memo<Point[] | null>(`space-boundary:${space.id}`, () => deriveSpaceBoundary(space.position, walls));
  return poly && poly.length >= 3 ? poly : null;
}

/** Net area of a room for tags and labels (memoised per render pass), or null without an outline. */
export function roomNetAreaFromCtx(space: CanonicalElement, ctx: GeometryContext): number | null {
  const poly = roomPolygonFromCtx(space, ctx);
  if (!poly) return null;
  return ctx.memo<number>(`space-net-area:${space.id}`, () => roomAreasOf(poly, boundaryWallsFromCtx(ctx)).area);
}
