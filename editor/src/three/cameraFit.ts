import { Box3, type Object3D, type BufferGeometry } from 'three';

export type Vec3 = [number, number, number];
export interface Box3D { min: Vec3; max: Vec3 }

/** World-space box of the visible geometry under `root` (hidden floors are skipped), or null if empty. */
export function visibleBox(root: Object3D): Box3D | null {
  root.updateWorldMatrix(true, true);
  const box = new Box3();
  const part = new Box3();
  root.traverseVisible(o => {
    const geo = (o as Object3D & { geometry?: BufferGeometry }).geometry;
    if (!geo?.attributes?.position) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox || geo.boundingBox.isEmpty()) return;
    box.union(part.copy(geo.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box.isEmpty() ? null : { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Default view: from the front-right, looking down about 30°. */
export const DEFAULT_VIEW_DIR: Vec3 = norm([1, 0.8, 1]);

/**
 * Perspective camera that frames every corner of `box`, orbiting its centre.
 * `dir` points from the target towards the camera; `margin` > 1 leaves a border.
 */
export function fitCameraToBox(
  box: Box3D, fovDeg: number, aspect: number, dir: Vec3 = DEFAULT_VIEW_DIR, margin = 1.3,
): { target: Vec3; position: Vec3; distance: number } {
  const target: Vec3 = [0, 1, 2].map(k => (box.min[k] + box.max[k]) / 2) as Vec3;
  const back = norm(dir);
  const right = norm(cross([0, 1, 0], back));
  const up = cross(back, right);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1);

  let distance = 0;
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
    const c = sub(corner, target);
    const towardCamera = dot(c, back);
    distance = Math.max(distance,
      towardCamera + Math.abs(dot(c, right)) / tanH,
      towardCamera + Math.abs(dot(c, up)) / tanV);
  }
  distance = Math.max(distance * margin, 1);
  const position: Vec3 = [target[0] + back[0] * distance, target[1] + back[1] * distance, target[2] + back[2] * distance];
  return { target, position, distance };
}
