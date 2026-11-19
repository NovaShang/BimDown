import { ExtrudeGeometry, Matrix4, Quaternion, Vector3, type Shape } from 'three';
import type { Point } from '../../model/elements.ts';

/**
 * Rotation that points local +Z along a model-space direction (dx, dy, dz)
 * — world (dx, dz, -dy), since model Y maps to world -Z and model Z to world Y.
 *
 * setFromUnitVectors would give the *shortest* rotation, leaving the profile's
 * roll unconstrained, so sloped rectangular members visibly twist. Build a full
 * basis instead, pinning local +Y as close to world up as possible.
 */
export function uprightAxisQuaternion(dx: number, dy: number, dz: number): Quaternion {
  const forward = new Vector3(dx, dz, -dy).normalize(); // local +Z
  let up = new Vector3(0, 1, 0);
  if (Math.abs(forward.dot(up)) > 0.999) up = new Vector3(1, 0, 0); // near-vertical
  const right = new Vector3().crossVectors(up, forward).normalize();     // local +X (width)
  const trueUp = new Vector3().crossVectors(forward, right).normalize(); // local +Y (depth)
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, trueUp, forward));
}

export interface MemberMesh {
  geometry: ExtrudeGeometry;
  position: [number, number, number];
  quaternion: Quaternion;
}

/**
 * Framing member (beam / brace): extrude the section along the 3D member line
 * with the line on the section's TOP edge — the BimDown / Revit convention
 * (beam z = top of the member, depth hangs down).
 *
 * `startZ` / `endZ` are relative to `baseY` (the level elevation).
 */
export function framingMemberMesh(
  shape: Shape,
  start: Point,
  end: Point,
  startZ: number,
  endZ: number,
  baseY: number,
): MemberMesh | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = endZ - startZ;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.001) return null;

  const geometry = new ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox!.max.y, 0);

  return {
    geometry,
    position: [start.x, baseY + startZ, -start.y],
    quaternion: uprightAxisQuaternion(dx, dy, dz),
  };
}
