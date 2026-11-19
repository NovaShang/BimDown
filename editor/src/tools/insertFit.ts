/**
 * Door / window placement without overlaps (Revit refuses an insert that
 * clashes with another on the same wall): a placement that only partly
 * overlaps slides to the nearest free spot; one whose centre lands on an
 * existing insert is refused. Inserts stacked one over the other (a window
 * above a door) don't clash — same rule as geometry/modelChecks.ts. An
 * embedded curtain wall occupies its stretch of the wall.
 */
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { arcLength } from '../geometry/arc.ts';
import { curtainEmbedSpan } from '../geometry/curtainEmbed.ts';
import { metre } from '../annotation/geometry.ts';

const INSERT_TABLES = new Set(['door', 'window', 'opening']);

export interface InsertSpan { id: string; lo: number; hi: number; sill: number; top: number }

/** Default sill / height of an insert row (as the wall's 3D voids, _lineWallShared.tsx). */
export function insertSill(table: string, attrs: Record<string, string>): { sill: number; height: number } {
  const raw = attrs.base_offset;
  const sill = raw !== undefined && raw !== '' ? parseFloat(raw) || 0 : table === 'window' ? 0.9 : 0;
  const dh = table === 'window' ? 1.2 : 2.1;
  return { sill, height: parseFloat(attrs.height ?? '') || dh };
}

function wallLength(w: LineElement): number {
  return w.arc ? arcLength(w.start, w.end, w.arc) : Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
}

/** Spans along `wall` taken by its doors / windows / openings (distance from the wall start). */
export function occupiedSpans(wall: LineElement, elements: ReadonlyMap<string, CanonicalElement>, exceptId?: string): InsertSpan[] {
  const out: InsertSpan[] = [];
  const len = wallLength(wall);
  const ux = len > 0 ? (wall.end.x - wall.start.x) / len : 0, uy = len > 0 ? (wall.end.y - wall.start.y) / len : 0;
  for (const el of elements.values()) {
    if (el.id === exceptId || !INSERT_TABLES.has(el.tableName)) continue;
    if ((el.hostId || el.attrs.host_id) !== wall.id) continue;
    let lo: number, hi: number;
    if (!wall.arc && (el.geometry === 'line' || el.geometry === 'spatial_line')) {
      const ln = el as LineElement;
      const a = (ln.start.x - wall.start.x) * ux + (ln.start.y - wall.start.y) * uy;
      const b = (ln.end.x - wall.start.x) * ux + (ln.end.y - wall.start.y) * uy;
      lo = Math.min(a, b); hi = Math.max(a, b);
    } else {
      const p = parseFloat(el.attrs.position ?? ''), w = parseFloat(el.attrs.width ?? '');
      if (!Number.isFinite(p) || !Number.isFinite(w)) continue;
      lo = p - w / 2; hi = p + w / 2;
    }
    const { sill, height } = insertSill(el.tableName, el.attrs);
    out.push({ id: el.id, lo, hi, sill, top: sill + height });
  }
  // A curtain wall embedded in the wall takes its stretch too (geometry/curtainEmbed.ts)
  for (const el of elements.values()) {
    if (el.tableName !== 'curtain_wall' || el.geometry !== 'line') continue;
    const span = curtainEmbedSpan(wall, wall.strokeWidth, el as LineElement, 0.005 * metre());
    if (span) out.push({ id: el.id, lo: span.lo, hi: span.hi, sill: parseFloat(el.attrs.base_offset ?? '') || 0, top: Infinity });
  }
  return out.sort((a, b) => a.lo - b.lo);
}

export type InsertFit = { ok: true; position: number; moved: boolean } | { ok: false; blockedBy: string };

/**
 * Where an insert of `width` (sill / height for the stacking test) wanted at
 * `want` along a wall of `length` fits among `spans`. `tol` = overlap allowed.
 */
export function fitInsert(spans: InsertSpan[], want: number, width: number, length: number, sill: number, height: number, tol: number): InsertFit {
  const half = width / 2;
  const clash = spans.filter(s => Math.min(s.top, sill + height) - Math.max(s.sill, sill) > tol);
  const clamp = (p: number) => Math.max(Math.min(half, length / 2), Math.min(length - Math.min(half, length / 2), p));
  const p0 = clamp(want);
  const hits = (p: number) => clash.filter(s => Math.min(s.hi, p + half) - Math.max(s.lo, p - half) > tol);
  if (hits(p0).length === 0) return { ok: true, position: p0, moved: false };
  // Clicked on an existing insert: refuse rather than stack a second one there
  const under = clash.find(s => want >= s.lo - tol && want <= s.hi + tol);
  if (under) return { ok: false, blockedBy: under.id };
  // Partly overlapping: the nearest spot either side that is free, within one width
  let best: number | null = null;
  for (const s of clash) {
    for (const p of [s.lo - half, s.hi + half]) {
      if (p - half < -tol || p + half > length + tol || hits(p).length > 0) continue;
      if (Math.abs(p - want) <= width && (best === null || Math.abs(p - want) < Math.abs(best - want))) best = p;
    }
  }
  if (best !== null) return { ok: true, position: best, moved: true };
  return { ok: false, blockedBy: hits(p0)[0].id };
}
