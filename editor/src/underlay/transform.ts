import type { Point } from '../model/elements.ts';
import type { Underlay } from './types.ts';

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

type Placement = Pick<Underlay, 'x' | 'y' | 'rotation' | 'scale'>;

const RAD = Math.PI / 180;

/** File-local coordinates → plan coordinates. */
export function localToWorld(u: Placement, p: Point): Point {
  const c = Math.cos(u.rotation * RAD), s = Math.sin(u.rotation * RAD);
  return {
    x: u.x + u.scale * (c * p.x - s * p.y),
    y: u.y + u.scale * (s * p.x + c * p.y),
  };
}

export function worldToLocal(u: Placement, p: Point): Point {
  const c = Math.cos(u.rotation * RAD), s = Math.sin(u.rotation * RAD);
  const dx = (p.x - u.x) / u.scale, dy = (p.y - u.y) / u.scale;
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/** SVG transform for a y-up group (inside the plan's `scale(1,-1)`). */
export function svgTransform(u: Placement): string {
  return `translate(${u.x} ${u.y}) rotate(${u.rotation}) scale(${u.scale})`;
}

/** Normalize an angle to (-180, 180]. */
export function normalizeDeg(a: number): number {
  let r = ((a + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

/**
 * Two-point calibration: the picked points `p1`, `p2` (plan coordinates on
 * the underlay as currently placed) are really `distance` apart. Scales about
 * `p1`, which stays put. Null when the points coincide or the distance is bad.
 */
export function calibrate(u: Placement, p1: Point, p2: Point, distance: number): Placement | null {
  const measured = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(measured > 1e-12) || !(distance > 0) || !Number.isFinite(distance)) return null;
  const k = distance / measured;
  return {
    x: p1.x + (u.x - p1.x) * k,
    y: p1.y + (u.y - p1.y) * k,
    rotation: u.rotation,
    scale: u.scale * k,
  };
}

export function moveBy(u: Placement, dx: number, dy: number): Placement {
  return { ...pick(u), x: u.x + dx, y: u.y + dy };
}

/** Rotate the underlay by `deg` (counter-clockwise) about the plan point `center`. */
export function rotateAbout(u: Placement, center: Point, deg: number): Placement {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD);
  const ox = u.x - center.x, oy = u.y - center.y;
  return {
    x: center.x + c * ox - s * oy,
    y: center.y + s * ox + c * oy,
    rotation: normalizeDeg(u.rotation + deg),
    scale: u.scale,
  };
}

/** Angle in degrees swept from `from` to `to` around `center`. */
export function sweepDeg(center: Point, from: Point, to: Point): number {
  const a = Math.atan2(from.y - center.y, from.x - center.x);
  const b = Math.atan2(to.y - center.y, to.x - center.x);
  return normalizeDeg((b - a) / RAD);
}

/**
 * Placement that centers `local` bounds on `target`'s center. With no `scale`,
 * sizes the underlay to `fill` of the target box (fit both ways).
 */
export function placeInView(local: Bounds, target: Bounds, scale?: number, fill = 0.8): Placement {
  const lw = Math.max(local.maxX - local.minX, 1e-9);
  const lh = Math.max(local.maxY - local.minY, 1e-9);
  const tw = Math.max(target.maxX - target.minX, 1e-9);
  const th = Math.max(target.maxY - target.minY, 1e-9);
  const s = scale ?? Math.min(tw / lw, th / lh) * fill;
  const lcx = (local.minX + local.maxX) / 2, lcy = (local.minY + local.maxY) / 2;
  const tcx = (target.minX + target.maxX) / 2, tcy = (target.minY + target.maxY) / 2;
  return { x: tcx - s * lcx, y: tcy - s * lcy, rotation: 0, scale: s };
}

/** Plan-space bounding box of local bounds under a placement. */
export function worldBounds(u: Placement, local: Bounds): Bounds {
  const corners = [
    { x: local.minX, y: local.minY }, { x: local.maxX, y: local.minY },
    { x: local.maxX, y: local.maxY }, { x: local.minX, y: local.maxY },
  ].map(p => localToWorld(u, p));
  return {
    minX: Math.min(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
    maxX: Math.max(...corners.map(p => p.x)), maxY: Math.max(...corners.map(p => p.y)),
  };
}

function pick(u: Placement): Placement {
  return { x: u.x, y: u.y, rotation: u.rotation, scale: u.scale };
}
