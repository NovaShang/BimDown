/**
 * Wall-mounted devices (receptacles, switches, wash basins, wall-hung WCs,
 * panels): placed on the face of the nearest wall on the cursor's side, the
 * device's back (local -Y, where its pipe / cable ports go into the wall)
 * against it. The mounting height stays the template's / toolbar's base
 * offset.
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';

const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);
/** How far from a wall face the cursor may be for the device to go onto it. */
export const WALL_SNAP = 0.6;

export interface WallMount {
  /** Device origin: on the wall face, pushed out by half the device depth. */
  point: Point;
  /** Rotation (degrees) turning the device's back to the wall. */
  rotation: number;
  wallId: string;
}

/** The wall face placement for a device of plan depth `depth` near `p`, or null. */
export function wallMount(p: Point, elements: ReadonlyMap<string, CanonicalElement>, depth: number): WallMount | null {
  let best: (WallMount & { d: number }) | null = null;
  for (const el of elements.values()) {
    if (!WALL_TABLES.has(el.tableName) || el.geometry !== 'line') continue;
    const w = el as LineElement;
    const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    const t = (p.x - w.start.x) * ux + (p.y - w.start.y) * uy;
    if (t < 0 || t > len) continue;
    const side = (p.x - w.start.x) * -uy + (p.y - w.start.y) * ux; // signed offset from the centre line
    const half = (w.strokeWidth || parseFloat(w.attrs.thickness || '0.2') || 0.2) / 2;
    const fromFace = Math.abs(side) - half;
    if (fromFace > WALL_SNAP) continue;
    if (best && fromFace >= best.d) continue;
    const s = side >= 0 ? 1 : -1;
    // Outward normal on the cursor's side; the device's -Y points back into the wall.
    const nx = -uy * s, ny = ux * s;
    const off = half + Math.max(depth, 0) / 2;
    const point = { x: w.start.x + ux * t + nx * off, y: w.start.y + uy * t + ny * off };
    // Local +Y maps to the outward normal: rotation = angle(n) - 90°.
    const rotation = Math.round(((Math.atan2(ny, nx) * 180) / Math.PI - 90) * 100) / 100;
    best = { point, rotation: ((rotation % 360) + 360) % 360, wallId: w.id, d: fromFace };
  }
  if (!best) return null;
  return { point: best.point, rotation: best.rotation, wallId: best.wallId };
}
