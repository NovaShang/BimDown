export type TourSide = 'top' | 'bottom' | 'left' | 'right';

interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * Top-left corner (px) of a tour bubble of `bubble` size placed on `side` of
 * the highlighted `target`, `gap` px away, then clamped so the whole bubble
 * stays `margin` px inside the viewport.
 */
export function placeTourBubble(
  target: Rect,
  side: TourSide,
  bubble: { w: number; h: number },
  viewport: { w: number; h: number },
  gap: number,
  margin = 8,
): { left: number; top: number } {
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  let left: number, top: number;
  if (side === 'top') { left = cx - bubble.w / 2; top = target.top - gap - bubble.h; }
  else if (side === 'bottom') { left = cx - bubble.w / 2; top = target.bottom + gap; }
  else if (side === 'right') { left = target.right + gap; top = cy - bubble.h / 2; }
  else { left = target.left - gap - bubble.w; top = cy - bubble.h / 2; }
  const clamp = (v: number, size: number, max: number) => Math.max(margin, Math.min(v, max - size - margin));
  return { left: clamp(left, bubble.w, viewport.w), top: clamp(top, bubble.h, viewport.h) };
}
