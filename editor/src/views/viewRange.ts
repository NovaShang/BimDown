/**
 * Plan view range: where an element sits relative to the plan cut plane.
 *
 * `below` = entirely under the cut (floors, slabs, railings: drawn as seen from
 * above), `cut` = crosses the cut plane (walls, columns, doors, most windows),
 * `above` = entirely over it (beams, ceilings, high windows: overhead, dashed in
 * a floor plan). Heights are relative to the element's level, project units.
 */
import type { CanonicalElement } from '../model/elements.ts';
import type { AboveCutStyle } from './viewTypes.ts';

export type RangeClass = 'below' | 'cut' | 'above';

/** Tables the view range never hides or dashes: annotation, rooms, and MEP
 *  (services plans show ducts and pipes over the ceiling void at full weight). */
const EXEMPT_TABLES = new Set([
  'space', 'room_separator', 'grid', 'mesh',
  'duct', 'pipe', 'cable_tray', 'conduit', 'equipment', 'terminal', 'mep_node', 'connector',
]);

/** Always overhead regardless of the stored offset (a ceiling is hung from above). */
const ALWAYS_ABOVE = new Set(['ceiling']);

const num = (v: string | undefined, fallback: number) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/** Vertical span [bottom, top] above the level, or null when the table is exempt. */
export function verticalSpan(el: CanonicalElement): [number, number] | null {
  if (EXEMPT_TABLES.has(el.tableName) || el.attrs.mesh_file) return null;
  const a = el.attrs;
  const base = num(a.base_offset, 0);
  switch (el.tableName) {
    case 'window': {
      const sill = num(a.base_offset, 0.9);
      return [sill, sill + num(a.height, 1.5)];
    }
    case 'door':
      return [base, base + num(a.height, 2.1)];
    case 'opening':
      return [base, base + num(a.height, 2.1)];
    case 'slab': case 'structure_slab': case 'foundation':
      // level + base_offset is the top face
      return [base - num(a.thickness, 0.2), base];
    case 'roof':
      return [base, base + num(a.thickness, 0.3)];
    case 'railing':
      return [base, base + num(a.height, 1.1)];
    case 'beam': case 'brace': {
      if (el.geometry !== 'spatial_line') return [base - 0.5, base];
      // Line is the member top; it hangs by the section depth.
      const depth = num(a.size_y, num(a.height, 0.5));
      return [Math.min(el.startZ, el.endZ) - depth, Math.max(el.startZ, el.endZ)];
    }
    case 'stair': case 'ramp':
      if (el.geometry === 'spatial_line') return [Math.min(el.startZ, el.endZ), Math.max(el.startZ, el.endZ, 2)];
      return [base, base + 3];
    default:
      // Walls, columns, curtain walls, stair parts: base → level above (≥ cut).
      return [base, base + num(a.height, 3)];
  }
}

export function classifyRange(el: CanonicalElement, cut: number): RangeClass | null {
  if (ALWAYS_ABOVE.has(el.tableName)) return 'above';
  const span = verticalSpan(el);
  if (!span) return null;
  const [bottom, top] = span;
  if (bottom >= cut) return 'above';
  if (top <= cut) return 'below';
  return 'cut';
}

/** How the plan draws an element: normal, dashed overhead, or not at all. */
export type RangeDisplay = 'normal' | 'overhead' | 'hidden';

export function rangeDisplay(cls: RangeClass | null, rcp: boolean, aboveCut: AboveCutStyle): RangeDisplay {
  if (cls === null) return 'normal';
  if (rcp) return cls === 'below' ? 'hidden' : 'normal';
  if (cls === 'above') return aboveCut === 'hidden' ? 'hidden' : 'overhead';
  return 'normal';
}
