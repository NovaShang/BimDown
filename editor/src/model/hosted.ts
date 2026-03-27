/**
 * Unified hosted element geometry resolution.
 *
 * Hosted elements (doors, windows) are positioned parametrically along a host wall.
 * This module provides shared functions for resolving and computing that geometry.
 */
import type { Point, LineElement } from './elements.ts';

/**
 * Resolve hosted element geometry from host wall + parametric position.
 *
 * @param hostWall - The host wall LineElement
 * @param position - 0.0 (wall start) to 1.0 (wall end), center of opening
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

  // Center distance along wall
  const center = position * wallLen;
  const half = width / 2;

  // Clamp so the opening stays within wall bounds
  const lo = Math.max(0, Math.min(wallLen - width, center - half));
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
 * Compute parametric position (0-1) of a point along a wall.
 * Used when serializing hosted elements back to CSV.
 *
 * @param hostWall - The host wall LineElement
 * @param center - The center point of the opening
 * @returns position 0.0-1.0
 */
export function computeHostedPosition(
  hostWall: LineElement,
  center: Point,
): number {
  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);

  if (wallLen < 1e-6) return 0.5;

  const px = center.x - hostWall.start.x;
  const py = center.y - hostWall.start.y;
  const t = (px * dx + py * dy) / (wallLen * wallLen);

  return Math.max(0, Math.min(1, t));
}
