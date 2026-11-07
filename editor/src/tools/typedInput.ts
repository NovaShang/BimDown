/**
 * Typed dimensions while drawing or moving (Revit's listening dimension):
 * type a number for the length along the cursor direction, Tab to the angle
 * field, Enter to place. Values are in the project unit (store-as-displayed);
 * ft / in projects accept 5'-6" notation.
 */
import type { TypedInput } from '../state/editorTypes.ts';
import type { Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { parseImperialLength } from '../utils/units.ts';

/** Keys that start a typed value; once open, a sign and feet/inch marks too.
 *  (Space stays pan, '-' stays zoom-out until a value is open.) */
const START_CHAR = /^[0-9.]$/;
const NUMBER_CHAR = /^[0-9.\-'"]$/;

export interface TypedKeyResult {
  /** The key was consumed. */
  handled: boolean;
  /** Next typed state (undefined = cleared). */
  typed: TypedInput | undefined;
  /** Enter with a length: place the point. */
  commit?: boolean;
}

export function typedKey(e: KeyboardEvent, typed: TypedInput | undefined): TypedKeyResult {
  if (e.ctrlKey || e.metaKey || e.altKey) return { handled: false, typed };
  const cur = typed ?? { length: '', angle: '', field: 'length' as const };
  if (typed ? NUMBER_CHAR.test(e.key) : START_CHAR.test(e.key)) {
    const v = cur[cur.field] + e.key;
    return { handled: true, typed: { ...cur, [cur.field]: v } };
  }
  if (e.key === 'Tab') {
    return { handled: true, typed: { ...cur, field: cur.field === 'length' ? 'angle' : 'length' } };
  }
  if (!typed) return { handled: false, typed };
  if (e.key === 'Backspace') {
    const v = cur[cur.field].slice(0, -1);
    const next = { ...cur, [cur.field]: v };
    return { handled: true, typed: next.length === '' && next.angle === '' ? undefined : next };
  }
  if (e.key === 'Escape') return { handled: true, typed: undefined };
  if (e.key === 'Enter') return { handled: true, typed, commit: parseTypedLength(typed.length, 'm') != null || typed.angle.trim() !== '' };
  return { handled: false, typed };
}

export function parseTypedLength(raw: string, unit: ProjectUnit): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const v = unit === 'ft' || unit === 'in' ? parseImperialLength(s, unit) : parseFloat(s);
  return v != null && Number.isFinite(v) ? v : null;
}

/** The point the typed values describe from `anchor`: length along the typed
 *  angle (degrees CCW from +X) or, without one, toward the cursor. */
export function resolveTypedPoint(
  anchor: Point,
  cursor: Point | null,
  typed: TypedInput,
  unit: ProjectUnit,
): Point | null {
  const angleRaw = typed.angle.trim();
  let dir: Point;
  if (angleRaw !== '' && Number.isFinite(parseFloat(angleRaw))) {
    const a = parseFloat(angleRaw) * Math.PI / 180;
    dir = { x: Math.cos(a), y: Math.sin(a) };
  } else {
    const dx = (cursor?.x ?? anchor.x + 1) - anchor.x, dy = (cursor?.y ?? anchor.y) - anchor.y;
    const len = Math.hypot(dx, dy);
    dir = len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  }
  const len = parseTypedLength(typed.length, unit)
    ?? (cursor ? Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) : null);
  if (len == null || Math.abs(len) < 1e-9) return null;
  return { x: anchor.x + dir.x * len, y: anchor.y + dir.y * len };
}

/** Rectangle variant: length = width along X, angle field = height along Y;
 *  signs follow the cursor's quadrant around the first corner. */
export function resolveTypedRectCorner(
  anchor: Point,
  cursor: Point | null,
  typed: TypedInput,
  unit: ProjectUnit,
): Point | null {
  const sx = cursor && cursor.x < anchor.x ? -1 : 1;
  const sy = cursor && cursor.y < anchor.y ? -1 : 1;
  const w = parseTypedLength(typed.length, unit) ?? (cursor ? Math.abs(cursor.x - anchor.x) : null);
  const h = parseTypedLength(typed.angle, unit) ?? (cursor ? Math.abs(cursor.y - anchor.y) : null);
  if (w == null || h == null || Math.abs(w) < 1e-9 || Math.abs(h) < 1e-9) return null;
  return { x: anchor.x + sx * Math.abs(w), y: anchor.y + sy * Math.abs(h) };
}
