/**
 * Room geometry for the IFC export: which walls face outdoors. Edge matching
 * and the net (wall-face) outline are shared with the editor (geometry/roomArea.ts).
 * Uses the same wall graph as the editor's room derivation (spaceBoundary.ts).
 */
import type { LineElement, Point } from '../../model/elements.ts';
import { pointOnArc } from '../../geometry/arc.ts';
import { pickSpaceFace, type BoundedFace } from '../../geometry/spaceBoundary.ts';

/**
 * True when some stretch of the wall has open air (no bounded face of the wall
 * graph) on one side: sampled at a quarter, half and three quarters along.
 */
export function isExternalWall(w: LineElement, faces: BoundedFace[]): boolean {
  if (faces.length === 0) return true;
  const eps = 0.05;
  for (const t of [0.25, 0.5, 0.75]) {
    let p: Point, tx: number, ty: number;
    if (w.arc) {
      const r = pointOnArc(w.start, w.end, w.arc, t);
      p = r.point; tx = r.tangent.x; ty = r.tangent.y;
    } else {
      p = { x: w.start.x + (w.end.x - w.start.x) * t, y: w.start.y + (w.end.y - w.start.y) * t };
      tx = w.end.x - w.start.x; ty = w.end.y - w.start.y;
    }
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l;
    const left = pickSpaceFace({ x: p.x + nx * eps, y: p.y + ny * eps }, faces);
    const right = pickSpaceFace({ x: p.x - nx * eps, y: p.y - ny * eps }, faces);
    if (!left || !right) return true;
  }
  return false;
}
