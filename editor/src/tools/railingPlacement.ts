/**
 * Sketched railings: the railing tool draws a chain of segments (one railing
 * row each, click on to continue, Enter / Esc to stop). A segment drawn on or
 * along a slab edge is hosted on that slab and stands on its top (spec
 * railing.yaml), so it follows the slab's height.
 */
import type { CanonicalElement, Point, PolygonElement } from '../model/elements.ts';
import { pointPolygonDistance } from '../geometry/stair.ts';

const SLAB_TABLES = new Set(['slab', 'structure_slab']);
/** How far outside a slab outline a railing end may be and still count as on its edge (m). */
const EDGE_TOLERANCE = 0.3;

/** The slab a segment stands on (both ends on / inside it), topmost first. */
export function slabUnder(elements: Iterable<CanonicalElement> | undefined, a: Point, b: Point): PolygonElement | undefined {
  let best: PolygonElement | undefined;
  let bestTop = -Infinity;
  for (const el of elements ?? []) {
    if (!SLAB_TABLES.has(el.tableName) || el.geometry !== 'polygon') continue;
    const p = el as PolygonElement;
    if (p.vertices.length < 3) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ([a, b, mid].some(q => pointPolygonDistance(q, p.vertices) > EDGE_TOLERANCE)) continue;
    const top = parseFloat(p.attrs.base_offset || '0') || 0;
    if (top > bestTop) { bestTop = top; best = p; }
  }
  return best;
}

/** Host + Z of a sketched railing segment: on a slab (its top) or at the drawn height. */
export function railingSegmentHost(
  elements: Iterable<CanonicalElement> | undefined, a: Point, b: Point,
): { hostId: string; z: number } | null {
  const slab = slabUnder(elements, a, b);
  return slab ? { hostId: slab.id, z: parseFloat(slab.attrs.base_offset || '0') || 0 } : null;
}
