/**
 * Floors, roofs and ceilings made by picking walls follow them (Revit's
 * associated sketch lines): an edit that moves, flips, re-types or reshapes
 * one of an element's `boundary_walls` rebuilds its outline at its
 * `boundary_face` (+ `boundary_offset`) in the same undo step. Editing the
 * outline itself (vertex drag, moving the floor alone) ends the association.
 */
import type { CanonicalElement, LineElement, PolygonElement, Point } from './elements.ts';
import type { TypeCatalog } from './types/catalog.ts';
import { BOUNDED_TABLES, boundaryWallIds, rebuildBoundary } from '../geometry/pickBoundary.ts';
import { legacyEdgeSlopes, formatNumberList } from '../geometry/roofSolver.ts';

const BOUNDING_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function sameRing(a: Point[], b: Point[]): boolean {
  return a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6);
}

/** Wall-like lines whose geometry or build-up changed between `before` and `after`. */
function changedWalls(before: ReadonlyMap<string, CanonicalElement | null>, after: ReadonlyMap<string, CanonicalElement | null>): Set<string> {
  const out = new Set<string>();
  for (const [id, a] of after) {
    const b = before.get(id) ?? null;
    const el = a ?? b;
    if (!el || !BOUNDING_TABLES.has(el.tableName) || a === b) continue;
    out.add(id);
  }
  return out;
}

const unlink = (el: PolygonElement): PolygonElement => ({ ...el, attrs: { ...el.attrs, boundary_walls: '' } });

/**
 * Patch (id → element) for the wall-bounded elements of `elements` (the
 * level after the edit) that the edit `before` → `after` affects.
 */
export function followBoundaryWalls(
  before: ReadonlyMap<string, CanonicalElement | null>,
  after: ReadonlyMap<string, CanonicalElement | null>,
  elements: ReadonlyMap<string, CanonicalElement>,
  types?: TypeCatalog,
): Map<string, CanonicalElement> {
  const patch = new Map<string, CanonicalElement>();
  const walls = changedWalls(before, after);
  for (const el of elements.values()) {
    if (!BOUNDED_TABLES.has(el.tableName) || el.geometry !== 'polygon' || !el.attrs.boundary_walls) continue;
    const host = el as PolygonElement;
    const ids = boundaryWallIds(host.attrs);
    const touched = ids.some(id => walls.has(id));
    const was = before.get(host.id);
    // The outline was edited by hand (its walls untouched): a sketch from now on
    if (!touched) {
      if (was && was.geometry === 'polygon' && after.has(host.id) && !sameRing(was.vertices, host.vertices)) patch.set(host.id, unlink(host));
      continue;
    }
    const ring = rebuildBoundary(host, id => {
      const w = elements.get(id);
      return w && w.geometry === 'line' ? (w as LineElement) : undefined;
    }, types);
    if (!ring) continue; // the walls no longer close a loop: keep the last outline
    const vertices = ring.map(p => ({ x: round(p.x), y: round(p.y) }));
    if (sameRing(vertices, host.vertices)) continue;
    let attrs = host.attrs;
    // Roof edge slopes are per edge: re-derive them when the edge count changes
    if (host.tableName === 'roof' && attrs.edge_slopes && attrs.edge_slopes.split(';').length !== vertices.length) {
      const slope = parseFloat(attrs.slope || '0') || Math.max(0, ...attrs.edge_slopes.split(';').map(Number).filter(Number.isFinite));
      const kind = attrs.roof_type === 'mansard' || attrs.roof_type === 'extrusion' ? 'hip' : attrs.roof_type || 'hip';
      attrs = { ...attrs, edge_slopes: formatNumberList(legacyEdgeSlopes(vertices, kind, slope)) };
    }
    patch.set(host.id, { ...host, vertices, attrs });
  }
  return patch;
}
