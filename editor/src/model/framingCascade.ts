/**
 * Beams follow their columns: when columns move, every beam / brace end that
 * frames into one of them (the end point lies inside the column's footprint)
 * moves with it. Ends elsewhere stay put, so a beam between a moved and a
 * fixed column stretches like Revit's beam-to-column join.
 */
import type { CanonicalElement, LineElement } from './elements.ts';
import { COLUMN_TABLES, columnFootprint, insideFootprint } from '../elements/_framing.ts';

const FRAMING_TABLES = new Set(['beam', 'brace']);
const COLUMN_SET = new Set<string>(COLUMN_TABLES);
/** Slack around the column footprint, metres. */
const TOL = 0.01;

/**
 * Apply the cascade into `next` (already holding the moved columns) and return
 * the ids of the framing members it changed. `before` is the pre-move map; ids
 * in `moved` are moved wholesale and skipped.
 */
export function followColumnMoves(
  before: ReadonlyMap<string, CanonicalElement>,
  next: Map<string, CanonicalElement>,
  movedIds: readonly string[],
  moved: ReadonlySet<string>,
  dx: number,
  dy: number,
): string[] {
  const footprints = [];
  for (const id of movedIds) {
    const col = before.get(id);
    if (!col || !COLUMN_SET.has(col.tableName)) continue;
    const fp = columnFootprint(col);
    if (fp) footprints.push(fp);
  }
  if (footprints.length === 0) return [];

  const changed: string[] = [];
  for (const el of before.values()) {
    if (!FRAMING_TABLES.has(el.tableName) || moved.has(el.id)) continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    const ln = (next.get(el.id) ?? el) as LineElement;
    const startHit = footprints.some(fp => insideFootprint(fp, el.start, TOL));
    const endHit = footprints.some(fp => insideFootprint(fp, el.end, TOL));
    if (!startHit && !endHit) continue;
    next.set(el.id, {
      ...ln,
      start: startHit ? { x: ln.start.x + dx, y: ln.start.y + dy } : ln.start,
      end: endHit ? { x: ln.end.x + dx, y: ln.end.y + dy } : ln.end,
    });
    changed.push(el.id);
  }
  return changed;
}
