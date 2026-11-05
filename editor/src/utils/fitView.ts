import type { ViewTransform } from '../state/editorTypes.ts';

/** A rectangle in SVG user units (the plan's y is already flipped). */
export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Panels floating over the canvas mark themselves with `data-canvas-overlay="<side>"`. */
export const CANVAS_OVERLAY_ATTR = 'data-canvas-overlay';

const MIN_SCALE = 0.05;
const MAX_SCALE = 100;

/**
 * The SVG fills the container with the default `xMidYMid meet`: the viewBox is
 * scaled by `s` and centered. The canvas transform (translate + scale, origin
 * 0 0) is applied on top of that.
 */
function viewBoxMapping(viewBox: Box, size: Size) {
  const s = Math.min(size.w / viewBox.w, size.h / viewBox.h);
  return { s, ox: (size.w - viewBox.w * s) / 2, oy: (size.h - viewBox.h * s) / 2 };
}

/**
 * Transform that fits `content` (SVG units) inside the part of the canvas not
 * covered by `insets`, leaving `padding` px around it. Insets that would leave
 * less than ~a third of the canvas on an axis are ignored on that axis.
 */
export function fitTransform(content: Box, viewBox: Box, size: Size, insets: Insets = NO_INSETS, padding = 24): ViewTransform {
  let { left, right, top, bottom } = insets;
  if (size.w - left - right < size.w * 0.35) left = right = 0;
  if (size.h - top - bottom < size.h * 0.35) top = bottom = 0;
  const availW = Math.max(size.w - left - right - padding * 2, 1);
  const availH = Math.max(size.h - top - bottom - padding * 2, 1);

  const { s, ox, oy } = viewBoxMapping(viewBox, size);
  const scale = Math.min(Math.max(
    Math.min(availW / (Math.max(content.w, 1e-6) * s), availH / (Math.max(content.h, 1e-6) * s)),
    MIN_SCALE), MAX_SCALE);

  // Content center in the SVG element's local pixels, placed at the center of the free area
  const px = ox + (content.x + content.w / 2 - viewBox.x) * s;
  const py = oy + (content.y + content.h / 2 - viewBox.y) * s;
  return {
    x: left + (size.w - left - right) / 2 - px * scale,
    y: top + (size.h - top - bottom) / 2 - py * scale,
    scale,
  };
}

/**
 * The viewBox follows the model's extent, so it changes when content is added
 * from outside (an AI agent writing files). Return the transform that keeps
 * everything on screen exactly where it was under the old viewBox.
 */
export function keepInPlace(t: ViewTransform, from: Box, to: Box, size: Size): ViewTransform {
  const a = viewBoxMapping(from, size);
  const b = viewBoxMapping(to, size);
  const scale = (t.scale * a.s) / b.s;
  return {
    x: t.x + t.scale * (a.ox - from.x * a.s) - scale * (b.ox - to.x * b.s),
    y: t.y + t.scale * (a.oy - from.y * a.s) - scale * (b.oy - to.y * b.s),
    scale,
  };
}

export function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * When to fit the plan automatically:
 *  - a level is shown for the first time in this canvas (project open, floor
 *    switch, back from 3D) — always;
 *  - an empty level gets its first content (e.g. the AI builds into a blank
 *    project) — only if the user hasn't panned/zoomed or edited since.
 * Never otherwise, so the view doesn't jump under the user.
 */
export function shouldAutoFit(
  prev: { level: string | null; hadContent: boolean },
  next: { level: string; hasContent: boolean; userMoved: boolean; userEdited: boolean },
): boolean {
  if (next.level !== prev.level) return true;
  return next.hasContent && !prev.hadContent && !next.userMoved && !next.userEdited;
}

/** How far panels on each side reach into the container. */
export function insetsFromRects(container: DOMRectReadOnly, overlays: { side: string; rect: DOMRectReadOnly }[]): Insets {
  const out = { ...NO_INSETS };
  for (const { side, rect } of overlays) {
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= container.left || rect.left >= container.right || rect.bottom <= container.top || rect.top >= container.bottom) continue;
    if (side === 'left') out.left = Math.max(out.left, rect.right - container.left);
    else if (side === 'right') out.right = Math.max(out.right, container.right - rect.left);
    else if (side === 'top') out.top = Math.max(out.top, rect.bottom - container.top);
    else if (side === 'bottom') out.bottom = Math.max(out.bottom, container.bottom - rect.top);
  }
  return out;
}

/** Insets from the overlay panels currently in the page. */
export function measureOverlayInsets(container: HTMLElement): Insets {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(`[${CANVAS_OVERLAY_ATTR}]`), el => ({
    side: el.getAttribute(CANVAS_OVERLAY_ATTR) ?? '',
    rect: el.getBoundingClientRect(),
  }));
  return insetsFromRects(container.getBoundingClientRect(), overlays);
}
