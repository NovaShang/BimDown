import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh } from 'three';
import { fitCameraToBox, visibleBox, DEFAULT_VIEW_DIR, type Box3D, type Vec3 } from './cameraFit.ts';

/** Normalized device coords of a world point for a camera at `pos` looking at `target` (y up). */
function project(p: Vec3, pos: Vec3, target: Vec3, fovDeg: number, aspect: number): [number, number] {
  const back = norm(sub(pos, target));
  const right = norm(cross([0, 1, 0], back));
  const up = cross(back, right);
  const c = sub(p, pos);
  const depth = -dot(c, back);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return [dot(c, right) / (depth * t * aspect), dot(c, up) / (depth * t)];
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const corners = (b: Box3D): Vec3[] => Array.from({ length: 8 }, (_, i) =>
  [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]] as Vec3);

describe('fitCameraToBox', () => {
  // A 2-storey 40 x 15 m office far from the origin (where a fixed default camera would miss it)
  const box: Box3D = { min: [100, 0, -230], max: [140, 8, -215] };

  for (const aspect of [16 / 9, 1, 0.5]) {
    it(`frames every corner and fills the view (aspect ${aspect.toFixed(2)})`, () => {
      const { target, position } = fitCameraToBox(box, 50, aspect);
      expect(target).toEqual([120, 4, -222.5]);
      const ndc = corners(box).map(c => project(c, position, target, 50, aspect));
      const extent = Math.max(...ndc.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));
      expect(extent).toBeLessThanOrEqual(1);
      // tight: the model spans most of the view, not a corner of it
      expect(extent).toBeGreaterThan(0.65);
    });
  }

  it('views from the default direction and scales with the model', () => {
    const small = fitCameraToBox({ min: [0, 0, -10], max: [10, 3, 0] }, 50, 1.5);
    const big = fitCameraToBox({ min: [0, 0, -100], max: [100, 30, 0] }, 50, 1.5);
    expect(big.distance / small.distance).toBeCloseTo(10, 5);
    const d = norm(sub(small.position, small.target));
    d.forEach((v, k) => expect(v).toBeCloseTo(DEFAULT_VIEW_DIR[k], 6));
  });
});

describe('visibleBox', () => {
  it('measures placed meshes and skips hidden floors', () => {
    const root = new Group();
    const floor1 = new Group();
    const wall = new Mesh(new BoxGeometry(40, 4, 0.3));
    wall.position.set(120, 2, -215);
    floor1.add(wall);
    const hidden = new Group();
    hidden.visible = false;
    const far = new Mesh(new BoxGeometry(1, 1, 1));
    far.position.set(-500, 0, 0);
    hidden.add(far);
    root.add(floor1, hidden);
    const b = visibleBox(root)!;
    [100, 0, -215.15].forEach((v, k) => expect(b.min[k]).toBeCloseTo(v, 6));
    [140, 4, -214.85].forEach((v, k) => expect(b.max[k]).toBeCloseTo(v, 6));
    expect(visibleBox(new Group())).toBeNull();
  });
});
