/**
 * Boundary editing of polygon elements (slab, roof, ceiling, ...): insert a
 * vertex on an edge, delete a vertex. Per-edge attributes (a roof's
 * `edge_slopes`) are kept in step with the edges.
 */
import type { PolygonElement, Point } from '../model/elements.ts';
import { formatNumberList, parseNumberList } from './roofSolver.ts';

/** Attributes holding one value per polygon edge (semicolon lists). */
const PER_EDGE_ATTRS = ['edge_slopes'];

function editLists(el: PolygonElement, edit: (list: number[]) => void): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of PER_EDGE_ATTRS) {
    const list = parseNumberList(el.attrs[key]);
    if (list.length !== el.vertices.length) continue;
    edit(list);
    attrs[key] = formatNumberList(list);
  }
  return attrs;
}

/** Split edge `edge` (vertex edge → edge + 1) at `p`; both halves keep the edge's values. */
export function insertVertexChanges(el: PolygonElement, edge: number, p: Point): Pick<PolygonElement, 'vertices' | 'attrs'> {
  const vertices = [...el.vertices];
  vertices.splice(edge + 1, 0, { x: p.x, y: p.y });
  const attrs = editLists(el, list => list.splice(edge + 1, 0, list[edge]));
  return { vertices, attrs: { ...el.attrs, ...attrs } };
}

/** Remove vertex `v` (its two edges merge, keeping the first one's values); null below 3 vertices. */
export function removeVertexChanges(el: PolygonElement, v: number): Pick<PolygonElement, 'vertices' | 'attrs'> | null {
  if (el.vertices.length <= 3) return null;
  const vertices = el.vertices.filter((_, i) => i !== v);
  const attrs = editLists(el, list => list.splice(v, 1));
  return { vertices, attrs: { ...el.attrs, ...attrs } };
}
