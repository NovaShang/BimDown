// Project unit helpers.
//
// BimDown is "store-as-displayed": every coordinate in CSV / GeoJSON is in the
// unit declared by `project_metadata.json::units`. The editor never converts
// values — it only labels them. These helpers centralize unit lookup and
// display formatting so callers don't have to read state.project.metadata
// inline.

import type { ProjectUnit } from '../types.ts';

const VALID_UNITS: readonly ProjectUnit[] = ['m', 'ft', 'in', 'mm'];

/** Read the project's declared unit. Defaults to `'m'` for projects that
 *  predate the units field (or when no project is loaded). */
export function getProjectUnits(state: { project: { metadata?: { units?: string } } | null }): ProjectUnit {
  const raw = state.project?.metadata?.units;
  if (typeof raw === 'string' && (VALID_UNITS as readonly string[]).includes(raw)) {
    return raw as ProjectUnit;
  }
  return 'm';
}

/** Suffix string to render next to numeric inputs, prefixed by a leading space
 *  so it composes cleanly with adjacent text (e.g. `'1.5' + ' m'`). */
export function getUnitSuffix(unit: ProjectUnit): string {
  switch (unit) {
    case 'm':  return ' m';
    case 'ft': return ' ft';
    case 'in': return ' in';
    case 'mm': return ' mm';
  }
}

/** Parse user input that may be imperial notation (`5'-6"`, `5'6"`, `5' 6"`,
 *  `5'`, `6"`, `5.5'`) and return the numeric value in `target` units. Plain
 *  decimal strings (no `'` or `"`) fall through to a normal float parse so the
 *  caller can stay agnostic.
 *
 *  Returns `null` for empty / unparsable input.
 */
export function parseImperialLength(raw: string, target: 'ft' | 'in'): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  let sign = 1;
  let body = trimmed;
  if (body.startsWith('-') && (body.includes("'") || body.includes('"'))) {
    sign = -1;
    body = body.slice(1).trim();
  }
  if (!body.includes("'") && !body.includes('"')) {
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const m = body.match(/^(?:(\d+(?:\.\d+)?)\s*')?\s*-?\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const feet = m[1] ? parseFloat(m[1]) : 0;
  const inches = m[2] ? parseFloat(m[2]) : 0;
  const totalInches = feet * 12 + inches;
  return sign * (target === 'ft' ? totalInches / 12 : totalInches);
}

/** Format a numeric length already expressed in `unit` (no conversion). Phase 1
 *  uses straight decimal display with unit-appropriate precision:
 *
 *  - `m`  → 3 decimals when |v| < 10, otherwise 2 decimals
 *  - `ft` → 2 decimals (decimal feet — pretty `1'-3"` formatting is future work)
 *  - `in` → 2 decimals
 *  - `mm` → 0 decimals (millimeter precision is already fine-grained)
 *
 *  Tiny lengths in `m` flip to a `mm` label for readability (the standard
 *  drafting convention; matches the editor's pre-units behavior).
 */
export function formatLength(value: number, unit: ProjectUnit): string {
  if (!Number.isFinite(value)) return `0${getUnitSuffix(unit)}`;
  const abs = Math.abs(value);
  switch (unit) {
    case 'm':
      if (abs < 1) return `${(value * 1000).toFixed(0)} mm`;
      return abs < 10 ? `${value.toFixed(3)} m` : `${value.toFixed(2)} m`;
    case 'ft':
      return `${value.toFixed(2)} ft`;
    case 'in':
      return `${value.toFixed(2)} in`;
    case 'mm':
      return `${value.toFixed(0)} mm`;
  }
}
