/**
 * Annotation tables (dimension / text_note / tag): CSV-only plan annotations
 * with inline coordinates (spec csv-schema/annotation/). Kept dependency-free
 * so model/parse.ts and model/serialize.ts can import it without cycles.
 *
 * Editor representation:
 *   - dimension → LineElement: start/end = the stored measured points.
 *   - text_note → PointElement at x,y.
 *   - tag       → PointElement. Pinned (x,y set): position is absolute.
 *                 Unpinned (x,y empty): the tag sits at its host's default
 *                 spot; `position` holds the last resolved spot and
 *                 `tagBase` the same point, so a drag shows up as
 *                 position − tagBase (see annotation/sync.ts).
 */
import type { CanonicalElement, LineElement, PointElement, Point } from '../model/elements.ts';

export const ANNOTATION_TABLES: ReadonlySet<string> = new Set(['dimension', 'text_note', 'tag']);
export const ANNOTATION_DISCIPLINE = 'annotation';

export const DIMENSION_HEADERS = ['start_x', 'start_y', 'end_x', 'end_y', 'start_ref', 'end_ref', 'direction', 'offset', 'text'];
export const TEXT_NOTE_HEADERS = ['x', 'y', 'text', 'size', 'rotation'];
export const TAG_HEADERS = ['host_id', 'x', 'y', 'content'];

/** Unpinned tags carry the last resolved default spot (not persisted). */
export type TagElement = PointElement & { tagBase?: Point };

export function isAnnotationTable(table: string | undefined | null): boolean {
  return !!table && ANNOTATION_TABLES.has(table);
}

const num = (v: string | undefined, fallback = 0): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/** Round for CSV (mm precision in metre projects, like the GeoJSON writer). */
export function fmtCoord(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : '0';
}

export function isTagPinned(el: CanonicalElement): boolean {
  return (el.attrs.x ?? '') !== '' && (el.attrs.y ?? '') !== '';
}

/** Build the canonical element for one annotation CSV row. */
export function annotationElementFromRow(
  table: string,
  discipline: string,
  id: string,
  attrs: Record<string, string>,
): CanonicalElement {
  if (table === 'dimension') {
    const el: LineElement = {
      geometry: 'line', id, tableName: table, discipline,
      start: { x: num(attrs.start_x), y: num(attrs.start_y) },
      end: { x: num(attrs.end_x), y: num(attrs.end_y) },
      strokeWidth: 0.02,
      attrs,
    };
    return el;
  }
  const pinned = table !== 'tag' || ((attrs.x ?? '') !== '' && (attrs.y ?? '') !== '');
  const el: PointElement = {
    geometry: 'point', id, tableName: table, discipline,
    position: pinned ? { x: num(attrs.x), y: num(attrs.y) } : { x: 0, y: 0 },
    width: 0.3, height: 0.3,
    attrs,
  };
  return el;
}

/** Copy an annotation's geometry back into its CSV columns. */
export function syncAnnotationAttrs(el: CanonicalElement): CanonicalElement {
  if (el.tableName === 'dimension' && el.geometry === 'line') {
    const a = el.attrs;
    const next = {
      start_x: fmtCoord(el.start.x), start_y: fmtCoord(el.start.y),
      end_x: fmtCoord(el.end.x), end_y: fmtCoord(el.end.y),
    };
    if (a.start_x === next.start_x && a.start_y === next.start_y && a.end_x === next.end_x && a.end_y === next.end_y) return el;
    return { ...el, attrs: { ...a, ...next } };
  }
  if ((el.tableName === 'text_note' || (el.tableName === 'tag' && isTagPinned(el))) && el.geometry === 'point') {
    const x = fmtCoord(el.position.x), y = fmtCoord(el.position.y);
    if (el.attrs.x === x && el.attrs.y === y) return el;
    return { ...el, attrs: { ...el.attrs, x, y } };
  }
  return el;
}
