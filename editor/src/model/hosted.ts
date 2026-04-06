/**
 * Unified hosted element geometry resolution.
 *
 * Hosted elements (doors, windows) are positioned along a host wall.
 * Position is measured in meters from the wall start point.
 * Supports both straight and arc walls.
 */
import type { Point, LineElement } from './elements.ts';
import { arcLength, pointOnArc, nearestPointOnArc } from '../utils/arcMath.ts';

export function resolveHostedGeometry(
  hostWall: LineElement,
  position: number,
  width: number,
): { start: Point; end: Point } {
  if (hostWall.arc) {
    const wallLen = arcLength(hostWall.start, hostWall.end, hostWall.arc);
    if (wallLen < 1e-6) {
      return { start: { ...hostWall.start }, end: { ...hostWall.start } };
    }
    const half = width / 2;
    const lo = Math.max(0, Math.min(wallLen - width, position - half));
    const hi = lo + width;
    return {
      start: pointOnArc(hostWall.start, hostWall.end, hostWall.arc, lo / wallLen).point,
      end: pointOnArc(hostWall.start, hostWall.end, hostWall.arc, hi / wallLen).point,
    };
  }

  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 1e-6) {
    return { start: { ...hostWall.start }, end: { ...hostWall.start } };
  }
  const ux = dx / wallLen;
  const uy = dy / wallLen;
  const half = width / 2;
  const lo = Math.max(0, Math.min(wallLen - width, position - half));
  const hi = lo + width;
  return {
    start: { x: hostWall.start.x + ux * lo, y: hostWall.start.y + uy * lo },
    end: { x: hostWall.start.x + ux * hi, y: hostWall.start.y + uy * hi },
  };
}

export function computeHostedPosition(
  hostWall: LineElement,
  center: Point,
): number {
  if (hostWall.arc) {
    const wallLen = arcLength(hostWall.start, hostWall.end, hostWall.arc);
    if (wallLen < 1e-6) return 0;
    const { t } = nearestPointOnArc(center, hostWall.start, hostWall.end, hostWall.arc);
    return Math.max(0, Math.min(wallLen, t * wallLen));
  }
  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 1e-6) return 0;
  const px = center.x - hostWall.start.x;
  const py = center.y - hostWall.start.y;
  const t = (px * dx + py * dy) / (wallLen * wallLen);
  return Math.max(0, Math.min(wallLen, t * wallLen));
}
