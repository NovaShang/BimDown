/**
 * Unified hosted element geometry resolution.
 *
 * Hosted elements (doors, windows) are positioned along a host wall.
 * Position is measured in meters from the wall start point.
 */
import type { Point, LineElement } from './elements.ts';

/**
 * Resolve hosted element geometry from host wall + position in meters.
 *
 * @param hostWall - The host wall LineElement
 * @param position - Distance in meters from wall start to center of opening
 * @param width - Opening width in meters
 * @returns start/end points along the wall centerline
 */
export function resolveHostedGeometry(
  hostWall: LineElement,
  position: number,
  width: number,
): { start: Point; end: Point } {
  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);

  if (wallLen < 1e-6) {
    return { start: { ...hostWall.start }, end: { ...hostWall.start } };
  }

  const ux = dx / wallLen;
  const uy = dy / wallLen;

  const half = width / 2;

  // Clamp so the opening stays within wall bounds
  const lo = Math.max(0, Math.min(wallLen - width, position - half));
  const hi = lo + width;

  return {
    start: {
      x: hostWall.start.x + ux * lo,
      y: hostWall.start.y + uy * lo,
    },
    end: {
      x: hostWall.start.x + ux * hi,
      y: hostWall.start.y + uy * hi,
    },
  };
}

/**
 * Compute position in meters of a point along a wall.
 *
 * @param hostWall - The host wall LineElement
 * @param center - The center point of the opening
 * @returns distance in meters from wall start
 */
export function computeHostedPosition(
  hostWall: LineElement,
  center: Point,
): number {
  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);

  if (wallLen < 1e-6) return 0;

  const px = center.x - hostWall.start.x;
  const py = center.y - hostWall.start.y;
  const t = (px * dx + py * dy) / (wallLen * wallLen);

  return Math.max(0, Math.min(wallLen, t * wallLen));
}
