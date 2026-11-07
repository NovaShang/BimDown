import type { Point } from '../model/elements.ts';
import type { SnapResult } from '../utils/snap.ts';

/** Within this angle of horizontal / vertical a datum line locks to the axis. */
export const ORTHO_LOCK_DEG = 8;

/**
 * Orthogonal constraint for datum lines (sections, grids): the cursor's
 * direction from `anchor` within ORTHO_LOCK_DEG of an axis (or any direction
 * with Shift held) locks to that axis. The snapped point keeps its coordinate
 * along the axis, so object snaps still set the length.
 */
export function orthoLock(anchor: Point, raw: Point, snapped: Point, force: boolean): Point | null {
  const dx = raw.x - anchor.x, dy = raw.y - anchor.y;
  if (Math.hypot(dx, dy) < 1e-9) return null;
  const off = Math.atan2(Math.min(Math.abs(dx), Math.abs(dy)), Math.max(Math.abs(dx), Math.abs(dy))) * 180 / Math.PI;
  if (!force && off > ORTHO_LOCK_DEG) return null;
  return Math.abs(dx) >= Math.abs(dy) ? { x: snapped.x, y: anchor.y } : { x: anchor.x, y: snapped.y };
}

/** Apply orthoLock to a snap result (point and guides). */
export function orthoSnap(anchor: Point | undefined, raw: Point, snap: SnapResult, force: boolean): SnapResult {
  if (!anchor) return snap;
  const p = orthoLock(anchor, raw, snap.point, force);
  if (!p) return snap;
  const horizontal = p.y === anchor.y;
  const deg = Math.round(((Math.atan2(p.y - anchor.y, p.x - anchor.x) * 180 / Math.PI) + 360) % 360);
  // Keep the snap that set the length; drop the one across the axis.
  return {
    ...snap,
    point: p,
    snapX: horizontal ? snap.snapX : null,
    snapY: horizontal ? null : snap.snapY,
    guides: [
      ...snap.guides.filter(g => g.type !== 'angle_line'),
      { type: 'angle_line', x: anchor.x, y: anchor.y, x2: p.x, y2: p.y, snapType: 'angle', label: `${deg}°` },
    ],
  };
}
