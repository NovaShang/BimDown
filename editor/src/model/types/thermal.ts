/**
 * Thermal transmittance of a layered type (EN ISO 6946):
 *   U = 1 / (Rsi + Σ dᵢ / λᵢ + Rse)
 * Surface resistances by heat-flow direction: walls (horizontal) 0.13 / 0.04,
 * roofs and ceilings (upwards) 0.10 / 0.04, floors (downwards) 0.17 / 0.04
 * m²K/W. An air-gap layer without λ counts as an unventilated cavity
 * (0.18 m²K/W). Undefined when another layer has no conductivity.
 */
import type { ElementType, TypeLayer } from './catalog.ts';

const SURFACE: Record<string, [rsi: number, rse: number]> = {
  wall_type: [0.13, 0.04],
  roof_type: [0.10, 0.04],
  ceiling_type: [0.10, 0.04],
  slab_type: [0.17, 0.04],
};
const AIR_GAP_R = 0.18;

/** U-value (W/(m²·K)) of `layers` (thickness in project units, `upm` per metre). */
export function layersUValue(layers: readonly TypeLayer[], typeTable: string, upm = 1): number | undefined {
  const surf = SURFACE[typeTable];
  if (!surf || layers.length === 0) return undefined;
  let r = surf[0] + surf[1];
  for (const l of layers) {
    const d = l.thickness / upm;
    if (l.conductivity !== undefined && l.conductivity > 0) r += d / l.conductivity;
    else if (l.function === 'air_gap') r += AIR_GAP_R;
    else return undefined;
  }
  return 1 / r;
}

export function typeUValue(t: ElementType, upm = 1): number | undefined {
  return layersUValue(t.layers, t.table, upm);
}
