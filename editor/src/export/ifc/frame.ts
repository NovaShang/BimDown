/**
 * Schema-neutral geometry IR for the IFC writer. Everything is in IFC world
 * coordinates: plan X / Y, Z up, absolute elevation (metres). The writer turns
 * a product's solids into its local placement frame at write time.
 */

export type V2 = { x: number; y: number };
export type V3 = { x: number; y: number; z: number };

/** Right-handed placement: origin, local Z (axis) and local X (ref direction), both unit. */
export interface Frame { o: V3; z: V3; x: V3 }

/** Cross-section, in the solid frame's local XY. Parametric kinds are centred at (cx, cy). */
export type Profile =
  | { kind: 'rect'; w: number; d: number; cx?: number; cy?: number; name?: string }
  | { kind: 'circle'; r: number; cx?: number; cy?: number; name?: string }
  | { kind: 'ishape'; w: number; d: number; web: number; flange: number; cx?: number; cy?: number; name?: string }
  | { kind: 'poly'; outer: V2[]; holes?: V2[][]; name?: string };

export type Solid =
  /** Profile in the frame's XY plane, extruded along the frame's +Z by `depth`. */
  | { kind: 'extrude'; profile: Profile; frame: Frame; depth: number }
  /** Closed shell: planar polygon faces, outward winding (CCW seen from outside). */
  | { kind: 'brep'; faces: V3[][] };

export const UP: V3 = { x: 0, y: 0, z: 1 };
export const EAST: V3 = { x: 1, y: 0, z: 0 };

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const length = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export function normalize(a: V3): V3 {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}

/** Axis-aligned frame at `o`. */
export function frameAt(o: V3): Frame {
  return { o, z: UP, x: EAST };
}

/** Upright frame at `o` whose local X points along the plan direction `angle` (radians, CCW). */
export function planFrame(o: V3, angle: number): Frame {
  return { o, z: UP, x: { x: Math.cos(angle), y: Math.sin(angle), z: 0 } };
}

export const frameY = (f: Frame): V3 => cross(f.z, f.x);

/** World point → frame-local coordinates. */
export function toLocal(f: Frame, p: V3): V3 {
  const d = sub(p, f.o);
  return { x: dot(d, f.x), y: dot(d, frameY(f)), z: dot(d, f.z) };
}

/** World direction → frame-local direction. */
export function dirToLocal(f: Frame, v: V3): V3 {
  return { x: dot(v, f.x), y: dot(v, frameY(f)), z: dot(v, f.z) };
}

/** Frame-local point → world. */
export function toWorld(f: Frame, p: V3): V3 {
  const y = frameY(f);
  return {
    x: f.o.x + f.x.x * p.x + y.x * p.y + f.z.x * p.z,
    y: f.o.y + f.x.y * p.x + y.y * p.y + f.z.y * p.z,
    z: f.o.z + f.x.z * p.x + y.z * p.y + f.z.z * p.z,
  };
}

/** `child` (world) expressed relative to `parent` (world). */
export function relFrame(parent: Frame, child: Frame): Frame {
  return { o: toLocal(parent, child.o), z: dirToLocal(parent, child.z), x: dirToLocal(parent, child.x) };
}

/**
 * Frame for a member swept along a 3D axis: local Z along the axis, local X
 * horizontal (up × axis) so local Y is as close to world up as possible — the
 * basis `memberAxis.uprightAxisQuaternion` uses for the 3D view. Near-vertical
 * axes use plan +X as "up" exactly like the 3D view.
 */
export function memberFrame(start: V3, end: V3): Frame | null {
  const d = sub(end, start);
  if (length(d) < 1e-6) return null;
  const z = normalize(d);
  const up = Math.abs(dot(z, UP)) > 0.999 ? EAST : UP;
  return { o: start, z, x: normalize(cross(up, z)) };
}

export function polygonArea(pts: V2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonPerimeter(pts: V2[]): number {
  let l = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    l += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return l;
}

/** Drop a duplicated closing vertex and consecutive duplicates. */
export function cleanRing(pts: V2[], tol = 1e-6): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  return out;
}
