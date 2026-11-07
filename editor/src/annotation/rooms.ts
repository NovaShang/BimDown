/**
 * Room (space) boundary + area helpers shared by tags, the properties panel
 * and schedules. Boundaries come from the same half-edge derivation the plan
 * uses (geometry/spaceBoundary.ts, a port of `bimdown build`), so areas match
 * the CLI's space.geojson (wall centre lines).
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import { deriveSpaceBoundary, BOUNDARY_TABLES } from '../geometry/spaceBoundary.ts';

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

/** Same as roomPolygon, memoised per render pass with the keys the space module uses. */
export function roomPolygonFromCtx(space: CanonicalElement, ctx: GeometryContext): Point[] | null {
  if (space.geometry !== 'point') return roomPolygon(space, []);
  const walls = ctx.memo<LineElement[]>('space-boundary:walls', () => {
    const collected: LineElement[] = [];
    for (const table of BOUNDARY_TABLES) {
      for (const e of ctx.elementsByTable(table)) if (e.geometry === 'line') collected.push(e as LineElement);
    }
    return collected;
  });
  const poly = ctx.memo<Point[] | null>(`space-boundary:${space.id}`, () => deriveSpaceBoundary(space.position, walls));
  return poly && poly.length >= 3 ? poly : null;
}
