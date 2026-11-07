import type { Bounds } from './transform.ts';

/** Meters per DXF unit for the $INSUNITS codes we expect in plans. */
const INSUNITS_TO_M: Record<number, number> = {
  1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 14: 0.1,
};

export function dxfUnitToMeters(insUnits: number, bounds: Bounds): number {
  const known = INSUNITS_TO_M[insUnits];
  if (known) return known;
  // Unitless: plans drawn in mm are thousands of units across.
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  return size > 2000 ? 0.001 : 1;
}
