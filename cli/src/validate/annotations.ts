/**
 * Annotation table checks (dimension / text_note / tag) beyond the generic
 * header, enum and reference validation: numbers parse, dimension end
 * references use the `<id>[:anchor]` syntax and point at an element on the
 * same level (or in global/), tags tag something on their own level.
 */
import type { CsvData } from '../utils/csv.js';
import type { IdRegistry } from './ids.js';

/** Anchors allowed after the colon of a dimension reference. */
export const DIMENSION_ANCHORS = ['start', 'end', 'left', 'right', 'center'];

const NUMERIC_FIELDS: Record<string, string[]> = {
  dimension: ['start_x', 'start_y', 'end_x', 'end_y', 'direction', 'offset'],
  text_note: ['x', 'y', 'size', 'rotation'],
  tag: ['x', 'y'],
};

/** Split "w-1:left" into { id: "w-1", anchor: "left" }; anchor is '' when absent. */
export function parseDimensionRef(ref: string): { id: string; anchor: string } {
  const colon = ref.lastIndexOf(':');
  if (colon < 0) return { id: ref, anchor: '' };
  const anchor = ref.slice(colon + 1);
  // Only a known anchor splits: ids never contain ':' but stay tolerant.
  if (!DIMENSION_ANCHORS.includes(anchor)) return { id: ref, anchor: '' };
  return { id: ref.slice(0, colon), anchor };
}

function onLevel(registry: IdRegistry, level: string, id: string): boolean {
  return registry.ids.has(`${level}/${id}`) || registry.ids.has(`global/${id}`);
}

export function validateAnnotations(
  path: string,
  tableName: string,
  data: CsvData,
  registry: IdRegistry,
): string[] {
  const numeric = NUMERIC_FIELDS[tableName];
  if (!numeric) return [];
  const issues: string[] = [];
  const level = path.split('/')[0];

  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    const at = `${path}:${i + 2}`;
    for (const f of numeric) {
      const v = row[f];
      if (v !== undefined && v !== '' && !Number.isFinite(Number(v))) {
        issues.push(`${at}  ${f}="${v}" is not a number`);
      }
    }

    if (tableName === 'dimension') {
      for (const side of ['start_ref', 'end_ref']) {
        const ref = (row[side] ?? '').trim();
        if (!ref) continue;
        const colon = ref.lastIndexOf(':');
        if (colon >= 0 && !DIMENSION_ANCHORS.includes(ref.slice(colon + 1))) {
          issues.push(`${at}  ${side} "${ref}" has an unknown anchor — use <id>, or <id>:${DIMENSION_ANCHORS.join('|')}`);
          continue;
        }
        const { id } = parseDimensionRef(ref);
        if (!registry.allIds.has(id)) {
          issues.push(`${at}  ${side} "${ref}" references non-existent id`);
        } else if (!onLevel(registry, level, id)) {
          issues.push(`${at}  ${side} "${ref}" is not on ${level} or in global/`);
        }
      }
      if (!row.start_ref && !row.end_ref && row.start_x === row.end_x && row.start_y === row.end_y) {
        issues.push(`${at}  dimension start and end points coincide`);
      }
    } else if (tableName === 'tag') {
      const hasX = (row.x ?? '') !== '';
      const hasY = (row.y ?? '') !== '';
      if (hasX !== hasY) issues.push(`${at}  set both x and y (pinned tag) or neither (tag follows its host)`);
      const host = row.host_id ?? '';
      if (host && registry.allIds.has(host) && !onLevel(registry, level, host)) {
        issues.push(`${at}  host_id "${host}" is not on ${level} or in global/`);
      }
    }
  }
  return issues;
}
