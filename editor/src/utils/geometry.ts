import type { ViewTransform } from '../state/editorTypes.ts';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Convert screen pixel coordinates to SVG coordinates */
export function screenToSvg(
  screenX: number,
  screenY: number,
  containerRect: DOMRect,
  viewBox: ViewBox,
  transform: ViewTransform,
): { x: number; y: number } {
  // Position within the container (0..containerW, 0..containerH)
  const cx = screenX - containerRect.left;
  const cy = screenY - containerRect.top;

  // Account for pan/zoom transform
  const adjustedX = (cx - transform.x) / transform.scale;
  const adjustedY = (cy - transform.y) / transform.scale;

  // Map to viewBox coordinates
  const svgX = viewBox.x + (adjustedX / containerRect.width) * viewBox.w;
  const svgY = viewBox.y + (adjustedY / containerRect.height) * viewBox.h;

  return { x: svgX, y: svgY };
}

/** Check if two axis-aligned bounding boxes intersect */
export function bboxIntersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/** Normalize a marquee rect (ensure positive w/h) */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}
