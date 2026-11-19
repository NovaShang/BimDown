/**
 * Arc math utilities for SVG arc (`A` command) support.
 *
 * SVG arcs use endpoint parameterization: M x1,y1 A rx,ry rotation largeArc sweep x2,y2
 * Most calculations require center parameterization, so we convert first.
 *
 * In BIM practice, arcs are always circular (rx === ry).
 */

import type { Point } from '../model/elements.ts';

export interface ArcParams {
  rx: number;
  ry: number;
  /** X-axis rotation in degrees */
  rotation: number;
  largeArc: boolean;
  sweep: boolean;
}

export interface CenterParams {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Start angle in radians */
  startAngle: number;
  /** Sweep angle in radians (positive = CCW, negative = CW) */
  sweepAngle: number;
  /** X-axis rotation in radians */
  phi: number;
}

// ─── SVG endpoint → center parameterization (SVG spec F.6.5/F.6.6) ──────────

export function svgArcToCenterParams(
  start: Point,
  end: Point,
  arc: ArcParams,
): CenterParams {
  const { largeArc, sweep } = arc;
  const phi = (arc.rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (start.x - end.x) / 2;
  const dy2 = (start.y - end.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rx = Math.abs(arc.rx);
  let ry = Math.abs(arc.ry);
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let rx2 = rx * rx;
  let ry2 = ry * ry;

  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const den = rx2 * y1p2 + ry2 * x1p2;
  if (num < 0) num = 0;
  let sq = Math.sqrt(num / den);
  if (largeArc === sweep) sq = -sq;

  const cxp = sq * (rx * y1p) / ry;
  const cyp = sq * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const vx1 = (x1p - cxp) / rx;
  const vy1 = (y1p - cyp) / ry;
  const vx2 = (-x1p - cxp) / rx;
  const vy2 = (-y1p - cyp) / ry;

  const startAngle = vectorAngle(1, 0, vx1, vy1);
  let sweepAngle = vectorAngle(vx1, vy1, vx2, vy2);

  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  return { cx, cy, rx, ry, startAngle, sweepAngle, phi };
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const uLen = Math.sqrt(ux * ux + uy * uy);
  const vLen = Math.sqrt(vx * vx + vy * vy);
  let dot = (ux * vx + uy * vy) / (uLen * vLen);
  dot = Math.max(-1, Math.min(1, dot));
  return sign * Math.acos(dot);
}

// ─── Evaluate point on arc at parameter t ∈ [0,1] ───────────────────────────

export function pointOnArc(
  start: Point,
  end: Point,
  arc: ArcParams,
  t: number,
): { point: Point; tangent: Point } {
  const c = svgArcToCenterParams(start, end, arc);
  const angle = c.startAngle + t * c.sweepAngle;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  const cosPhi = Math.cos(c.phi);
  const sinPhi = Math.sin(c.phi);

  const px = cosPhi * c.rx * cosAngle - sinPhi * c.ry * sinAngle + c.cx;
  const py = sinPhi * c.rx * cosAngle + cosPhi * c.ry * sinAngle + c.cy;

  const tdx = -c.rx * sinAngle;
  const tdy = c.ry * cosAngle;
  const tx = cosPhi * tdx - sinPhi * tdy;
  const ty = sinPhi * tdx + cosPhi * tdy;
  const tLen = Math.sqrt(tx * tx + ty * ty);
  const sign = c.sweepAngle >= 0 ? 1 : -1;

  return {
    point: { x: px, y: py },
    tangent: tLen > 1e-10
      ? { x: (sign * tx) / tLen, y: (sign * ty) / tLen }
      : { x: 1, y: 0 },
  };
}

// ─── Tessellate arc into polyline ────────────────────────────────────────────

export function tessellateArc(
  start: Point,
  end: Point,
  arc: ArcParams,
  maxSegLen: number = 0.05,
): Point[] {
  const c = svgArcToCenterParams(start, end, arc);
  const r = Math.max(c.rx, c.ry);
  const absAngle = Math.abs(c.sweepAngle);
  const segCount = Math.max(8, Math.ceil(absAngle * r / maxSegLen));

  const pts: Point[] = [{ x: start.x, y: start.y }];
  for (let i = 1; i < segCount; i++) {
    const t = i / segCount;
    pts.push(pointOnArc(start, end, arc, t).point);
  }
  pts.push({ x: end.x, y: end.y });
  return pts;
}

// ─── Arc length ──────────────────────────────────────────────────────────────

export function arcLength(start: Point, end: Point, arc: ArcParams): number {
  const c = svgArcToCenterParams(start, end, arc);
  if (Math.abs(c.rx - c.ry) < 1e-6) {
    return c.rx * Math.abs(c.sweepAngle);
  }
  const pts = tessellateArc(start, end, arc);
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

// ─── Nearest point on arc to cursor ──────────────────────────────────────────

export function nearestPointOnArc(
  cursor: Point,
  start: Point,
  end: Point,
  arc: ArcParams,
): { point: Point; t: number; distance: number } {
  const c = svgArcToCenterParams(start, end, arc);
  const cosPhi = Math.cos(c.phi);
  const sinPhi = Math.sin(c.phi);

  const dx = cursor.x - c.cx;
  const dy = cursor.y - c.cy;
  const lx = cosPhi * dx + sinPhi * dy;
  const ly = -sinPhi * dx + cosPhi * dy;

  const cursorAngle = Math.atan2(ly / c.ry, lx / c.rx);

  const sa = c.startAngle;
  const ea = sa + c.sweepAngle;
  let bestAngle: number;

  if (c.sweepAngle >= 0) {
    const a = ((cursorAngle - sa) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (a <= c.sweepAngle) {
      bestAngle = sa + a;
    } else {
      const dStart = angleDist(cursorAngle, sa);
      const dEnd = angleDist(cursorAngle, ea);
      bestAngle = dStart <= dEnd ? sa : ea;
    }
  } else {
    const a = ((sa - cursorAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (a <= -c.sweepAngle) {
      bestAngle = sa - a;
    } else {
      const dStart = angleDist(cursorAngle, sa);
      const dEnd = angleDist(cursorAngle, ea);
      bestAngle = dStart <= dEnd ? sa : ea;
    }
  }

  const t = c.sweepAngle !== 0 ? (bestAngle - sa) / c.sweepAngle : 0;
  const { point } = pointOnArc(start, end, arc, Math.max(0, Math.min(1, t)));
  const pdx = point.x - cursor.x;
  const pdy = point.y - cursor.y;

  return { point, t: Math.max(0, Math.min(1, t)), distance: Math.sqrt(pdx * pdx + pdy * pdy) };
}

function angleDist(a: number, b: number): number {
  let d = ((a - b) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

// ─── Arc bounding box ────────────────────────────────────────────────────────

export function arcBounds(
  start: Point,
  end: Point,
  arc: ArcParams,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = svgArcToCenterParams(start, end, arc);
  const cosPhi = Math.cos(c.phi);
  const sinPhi = Math.sin(c.phi);

  let minX = Math.min(start.x, end.x);
  let minY = Math.min(start.y, end.y);
  let maxX = Math.max(start.x, end.x);
  let maxY = Math.max(start.y, end.y);

  for (let k = 0; k < 4; k++) {
    const extremeAngle = (k * Math.PI) / 2;
    if (angleInSweep(extremeAngle, c.startAngle, c.sweepAngle)) {
      const cosA = Math.cos(extremeAngle);
      const sinA = Math.sin(extremeAngle);
      const px = cosPhi * c.rx * cosA - sinPhi * c.ry * sinA + c.cx;
      const py = sinPhi * c.rx * cosA + cosPhi * c.ry * sinA + c.cy;
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }

  return { minX, minY, maxX, maxY };
}

function angleInSweep(angle: number, startAngle: number, sweepAngle: number): boolean {
  if (sweepAngle === 0) return false;
  let d = ((angle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (sweepAngle > 0) {
    return d <= sweepAngle + 1e-10;
  } else {
    d = ((startAngle - angle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return d <= -sweepAngle + 1e-10;
  }
}

// ─── Compute arc from 3 points (for drag handle) ────────────────────────────

export function arcFromMidpoint(
  start: Point,
  end: Point,
  mid: Point,
): ArcParams | undefined {
  const chordMidX = (start.x + end.x) / 2;
  const chordMidY = (start.y + end.y) / 2;
  const chordLen = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
  if (chordLen < 1e-6) return undefined;

  const dMid = Math.sqrt((mid.x - chordMidX) ** 2 + (mid.y - chordMidY) ** 2);
  if (dMid < chordLen * 0.01) return undefined;

  const ax = start.x, ay = start.y;
  const bx = mid.x, by = mid.y;
  const cx = end.x, cy = end.y;

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-10) return undefined;

  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;

  const r = Math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2);

  // Sweep direction: cross < 0 → sweep = true (verified for SVG Y-axis convention)
  const cross = (end.x - start.x) * (mid.y - start.y) - (end.y - start.y) * (mid.x - start.x);
  const sweep = cross < 0;

  // largeArc: if mid is on same side of chord as center → major arc
  const mcX = (start.x + end.x) / 2;
  const mcY = (start.y + end.y) / 2;
  const dotCheck = (mid.x - mcX) * (ux - mcX) + (mid.y - mcY) * (uy - mcY);
  const largeArc = dotCheck > 0;

  return { rx: r, ry: r, rotation: 0, largeArc, sweep };
}

// ─── Arc midpoint ────────────────────────────────────────────────────────────

export function arcMidpoint(start: Point, end: Point, arc: ArcParams): Point {
  return pointOnArc(start, end, arc, 0.5).point;
}
