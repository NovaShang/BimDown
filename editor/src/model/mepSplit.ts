/**
 * Height helpers for MEP curves: the Z of an endpoint or of a point along a
 * (possibly sloped) run, and splitting a run at a tee without flattening it.
 * Z is level-relative, as everywhere in the editor model.
 */
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from './elements.ts';

type MepCurve = LineElement | SpatialLineElement;

/** Z of one end of a curve (flat lines: their base_offset). */
export function endZ(curve: MepCurve, side: 'start' | 'end'): number {
  if (curve.geometry === 'spatial_line') return side === 'start' ? curve.startZ : curve.endZ;
  return parseFloat(curve.attrs.base_offset ?? '') || 0;
}

/** Parameter of `p`'s projection on the curve's plan segment, clamped to [0, 1]. */
export function paramAlong(curve: MepCurve, p: Point): number {
  const dx = curve.end.x - curve.start.x, dy = curve.end.y - curve.start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 0;
  return Math.max(0, Math.min(1, ((p.x - curve.start.x) * dx + (p.y - curve.start.y) * dy) / len2));
}

/** Z of the curve above plan point `p` (linear along a sloped run). */
export function zAt(curve: MepCurve, p: Point): number {
  const t = paramAlong(curve, p);
  return endZ(curve, 'start') + (endZ(curve, 'end') - endZ(curve, 'start')) * t;
}

/**
 * Split `curve` at plan point `p` into an upstream half (keeps the id) and a
 * downstream half (`newId`), both wired to the tee node `nodeId`. The split
 * height is interpolated, so a sloped pipe keeps its slope on both halves.
 */
export function splitCurveAt(curve: MepCurve, p: Point, nodeId: string, newId: string): {
  upstream: MepCurve; downstream: MepCurve; z: number;
} {
  const z = zAt(curve, p);
  const at = { x: p.x, y: p.y };
  const spatial = curve.geometry === 'spatial_line';
  const upstream = {
    ...curve,
    end: at,
    ...(spatial ? { endZ: z } : {}),
    attrs: { ...curve.attrs, to: nodeId },
  } as MepCurve;
  const downstream = {
    ...curve,
    id: newId,
    start: at,
    ...(spatial ? { startZ: z } : {}),
    attrs: { ...curve.attrs, id: newId, from: nodeId, to: curve.attrs.to ?? '' },
  } as MepCurve;
  return { upstream, downstream, z };
}

/** A curve that runs straight up or down (no plan length). */
export function isVertical(curve: CanonicalElement): boolean {
  if (curve.geometry !== 'spatial_line') return false;
  return Math.hypot(curve.end.x - curve.start.x, curve.end.y - curve.start.y) < 1e-6;
}
