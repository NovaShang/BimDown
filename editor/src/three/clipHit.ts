import type { Plane, Vector3 } from 'three';

/** True when `point` survives the renderer's clipping planes (section box,
 *  floor range, section cut), so picking never hits geometry that isn't drawn. */
export function isPointVisible(point: Vector3, planes: readonly Plane[]): boolean {
  for (const p of planes) if (p.distanceToPoint(point) < -1e-4) return false;
  return true;
}
