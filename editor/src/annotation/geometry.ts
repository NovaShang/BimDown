/**
 * Pure annotation geometry shared by the plan renderer, the tools, the
 * associativity pass and the PDF export. Mirrors bimdown-spec/cli/src/annotations.ts
 * so `bimdown render` and the editor agree.
 *
 * Dimension references ("<id>[:anchor]"):
 *   <id>            line → stored point projected onto its location line;
 *                   door/window, point, room, polygon → centre
 *   <id>:start/end  line end points (door/window: opening edges)
 *   <id>:left/right wall face left/right of start→end (offset by thickness/2)
 *   <id>:center     centre
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { nearestPointOnArc, pointOnArc } from '../geometry/arc.ts';

export type Lookup = (id: string) => CanonicalElement | undefined;

export const DIMENSION_ANCHORS = ['start', 'end', 'left', 'right', 'center'] as const;
export type DimensionAnchor = typeof DIMENSION_ANCHORS[number] | '';

const UNIT_TO_M: Record<ProjectUnit, number> = { m: 1, ft: 0.3048, in: 0.0254, mm: 0.001 };

// ─── Project units (set once per project by the shell) ──────────────────────

let currentUnit: ProjectUnit = 'm';
export function setAnnotationUnits(unit: ProjectUnit): void { currentUnit = unit; }
export function annotationUnits(): ProjectUnit { return currentUnit; }
/** One metre in project units — drafting sizes (text, ticks) are given in metres. */
export function metre(unit: ProjectUnit = currentUnit): number { return 1 / UNIT_TO_M[unit]; }

// ─── Vectors ────────────────────────────────────────────────────────────────

export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
export const len = (a: Point) => Math.hypot(a.x, a.y);
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function projectOntoLine(p: Point, a: Point, b: Point): Point {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < 1e-12) return a;
  return add(a, mul(d, dot(sub(p, a), d) / l2));
}

function centroid(v: Point[]): Point {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    const c = p.x * q.y - q.x * p.y;
    area += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(area) < 1e-10) return mul(v.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / Math.max(1, v.length));
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

// ─── References ─────────────────────────────────────────────────────────────

export function parseRef(ref: string | undefined): { id: string; anchor: DimensionAnchor } {
  const r = (ref ?? '').trim();
  const colon = r.lastIndexOf(':');
  if (colon >= 0) {
    const anchor = r.slice(colon + 1);
    if ((DIMENSION_ANCHORS as readonly string[]).includes(anchor)) return { id: r.slice(0, colon), anchor: anchor as DimensionAnchor };
  }
  return { id: r, anchor: '' };
}

export function formatRef(id: string, anchor: DimensionAnchor): string {
  return anchor ? `${id}:${anchor}` : id;
}

/** Doors/windows/openings resolved onto a host wall. */
export function isHostedOpening(el: CanonicalElement): boolean {
  return el.geometry === 'line' && !!el.hostId;
}

/** Wall / host thickness for an element (host wall's for doors and windows). */
export function thicknessOf(el: CanonicalElement, lookup: Lookup): number {
  if (isHostedOpening(el)) {
    const host = lookup(el.hostId!);
    return host && (host.geometry === 'line' || host.geometry === 'spatial_line') ? host.strokeWidth : 0.2;
  }
  if (el.geometry === 'line' || el.geometry === 'spatial_line') {
    const t = parseFloat(el.attrs.thickness ?? '');
    return Number.isFinite(t) ? t : el.strokeWidth;
  }
  return 0;
}

/** Visual centre of an element: tag default spot and bare-id target of point-like refs. */
export function elementAnchor(el: CanonicalElement): Point {
  switch (el.geometry) {
    case 'line':
    case 'spatial_line':
      return el.arc ? pointOnArc(el.start, el.end, el.arc, 0.5).point : mid(el.start, el.end);
    case 'point':
      return el.position;
    case 'polygon':
      return centroid(el.vertices);
  }
}

/** Resolve one dimension end. Falls back to `stored` when the ref is empty or the element is gone. */
export function resolveRefPoint(ref: string | undefined, stored: Point, lookup: Lookup): Point {
  const { id, anchor } = parseRef(ref);
  if (!id) return stored;
  const el = lookup(id);
  if (!el) return stored;
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return elementAnchor(el);
  if (anchor === 'start') return el.start;
  if (anchor === 'end') return el.end;
  if (anchor === 'center' || isHostedOpening(el)) return elementAnchor(el);
  const ln = el as LineElement;
  if (ln.arc) {
    // Curved wall: nearest point on the centre arc, pushed out to a face
    const near = nearestPointOnArc(stored, ln.start, ln.end, ln.arc).point;
    if (anchor !== 'left' && anchor !== 'right') return near;
    const tangent = sub(pointOnArc(ln.start, ln.end, ln.arc, Math.min(1, nearestPointOnArc(stored, ln.start, ln.end, ln.arc).t + 1e-3)).point, near);
    const tl = len(tangent) || 1;
    const n = { x: -tangent.y / tl, y: tangent.x / tl };
    return add(near, mul(n, (anchor === 'left' ? 1 : -1) * thicknessOf(el, lookup) / 2));
  }
  let a = ln.start, b = ln.end;
  if (anchor === 'left' || anchor === 'right') {
    const d = sub(b, a);
    const l = len(d);
    if (l > 1e-9) {
      const n = mul({ x: -d.y / l, y: d.x / l }, (anchor === 'left' ? 1 : -1) * thicknessOf(el, lookup) / 2);
      a = add(a, n); b = add(b, n);
    }
  }
  return projectOntoLine(stored, a, b);
}

// ─── Dimension line ─────────────────────────────────────────────────────────

export interface DimensionGeometry {
  /** Measured points (resolved). */
  p1: Point; p2: Point;
  /** Dimension line ends. */
  d1: Point; d2: Point;
  /** Measured value ≥ 0. */
  value: number;
  /** Unit measurement direction and its left normal. */
  u: Point; n: Point;
}

export function parseDirection(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function dimensionGeometry(p1: Point, p2: Point, direction: number | null, offset: number): DimensionGeometry | null {
  let u: Point;
  if (direction !== null) {
    const a = direction * Math.PI / 180;
    u = { x: Math.cos(a), y: Math.sin(a) };
  } else {
    const d = sub(p2, p1);
    const l = len(d);
    if (l < 1e-9) return null;
    u = mul(d, 1 / l);
  }
  const n = { x: -u.y, y: u.x };
  const signed = dot(sub(p2, p1), u);
  const d1 = add(p1, mul(n, offset));
  const d2 = add(d1, mul(u, signed));
  return { p1, p2, d1, d2, value: Math.abs(signed), u, n };
}

/** Resolve a dimension element (refs + stored points + direction + offset). */
export function resolveDimension(el: CanonicalElement, lookup: Lookup): DimensionGeometry | null {
  if (el.geometry !== 'line') return null;
  const p1 = resolveRefPoint(el.attrs.start_ref, el.start, lookup);
  const p2 = resolveRefPoint(el.attrs.end_ref, el.end, lookup);
  const offset = parseFloat(el.attrs.offset ?? '');
  return dimensionGeometry(p1, p2, parseDirection(el.attrs.direction), Number.isFinite(offset) ? offset : 0);
}

/** Angle (deg) to draw text along `u`, flipped so it never reads upside down. */
export function readableAngle(u: Point): number {
  let a = Math.atan2(u.y, u.x) * 180 / Math.PI;
  if (a > 90.01 || a <= -89.99) a += 180;
  if (a > 180) a -= 360;
  return a;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Drafting text for a length in project units: mm for metric, feet-inches for imperial. */
export function formatDimension(value: number, unit: ProjectUnit = currentUnit): string {
  if (unit === 'm') return String(Math.round(value * 1000));
  if (unit === 'mm') return String(Math.round(value));
  const totalIn = unit === 'ft' ? value * 12 : value;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round((totalIn - ft * 12) * 4) / 4;
  if (inch >= 12) { ft += 1; inch -= 12; }
  return ft > 0 ? `${ft}'-${inch}"` : `${inch}"`;
}

/** Parse what a user typed into a temporary / permanent dimension back into project units. */
export function parseDimensionInput(raw: string, unit: ProjectUnit = currentUnit): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (unit === 'ft' || unit === 'in') {
    const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*')?\s*-?\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
    if (s.includes("'") && m) {
      const inches = (m[1] ? parseFloat(m[1]) * 12 : 0) + (m[2] ? parseFloat(m[2]) : 0);
      return unit === 'ft' ? inches / 12 : inches;
    }
    const v = parseFloat(s.replace('"', ''));
    if (!Number.isFinite(v)) return null;
    return s.includes('"') ? (unit === 'ft' ? v / 12 : v) : v;
  }
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  // Metric drafting values are typed in mm ("3600"); "3.6", "3.6m" are metres
  if (unit === 'm') {
    if (/mm$/i.test(s)) return v / 1000;
    if (/m$/i.test(s) || s.includes('.')) return v;
    return v / 1000;
  }
  return v;
}

export function formatArea(area: number, unit: ProjectUnit = currentUnit): string {
  return `${area.toFixed(unit === 'mm' ? 0 : 2)} ${unit}²`;
}

// ─── Tags ───────────────────────────────────────────────────────────────────

export const TAG_CONTENTS = ['auto', 'number', 'name', 'type', 'size', 'area'] as const;

/** Size descriptor: door/window width×height, section size, wall thickness. */
export function sizeText(el: CanonicalElement, unit: ProjectUnit = currentUnit): string {
  const a = el.attrs;
  const f = (v: string | undefined) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? formatDimension(n, unit) : '';
  };
  if (a.width && a.height) return `${f(a.width)}×${f(a.height)}`;
  if (a.size_x && a.size_y) return `${f(a.size_x)}×${f(a.size_y)}`;
  if (a.size_x) return `Ø${f(a.size_x)}`;
  if (a.thickness) return f(a.thickness);
  if (a.width) return f(a.width);
  return '';
}

/** Lines a tag shows for its host. `roomArea` is the derived area of a room host. */
export function tagLines(host: CanonicalElement, content: string | undefined, roomArea: number | null, unit: ProjectUnit = currentUnit): string[] {
  const a = host.attrs;
  const number = (a.number ?? '').trim();
  const name = (a.name ?? '').trim();
  const area = roomArea !== null && roomArea > 0 ? formatArea(roomArea, unit) : '';
  switch (content || 'auto') {
    case 'number': return [number || host.id];
    case 'name': return [name || number || host.id];
    case 'type': return [(a.type_name ?? a.type_id ?? a.type ?? '').trim() || sizeText(host, unit) || host.id];
    case 'size': return [sizeText(host, unit) || host.id];
    case 'area': return [area || '—'];
    default: {
      if (host.tableName === 'space') {
        const lines = [name, number, area].filter(Boolean);
        return lines.length ? lines : [host.id];
      }
      if (host.tableName === 'door' || host.tableName === 'window') return [number || sizeText(host, unit) || host.id];
      return [number || name || host.id];
    }
  }
}

/** Default (unpinned) tag spot: room seed; beside a door/window; element centre. */
export function tagDefaultPosition(host: CanonicalElement, lookup: Lookup, unit: ProjectUnit = currentUnit): Point {
  if (isHostedOpening(host) && host.geometry === 'line') {
    const d = sub(host.end, host.start);
    const l = len(d) || 1;
    const n = { x: -d.y / l, y: d.x / l };
    return add(mid(host.start, host.end), mul(n, thicknessOf(host, lookup) / 2 + 0.35 * metre(unit)));
  }
  return elementAnchor(host);
}

/** Tag size estimate (model units) for hit boxes and the PDF. */
export function tagBox(lines: string[], room: boolean, unit: ProjectUnit = currentUnit): { w: number; h: number; size: number } {
  const m = metre(unit);
  const size = (room ? 0.24 : 0.2) * m;
  const w = Math.max(...lines.map(l => textWidth(l, size))) + 0.16 * m;
  const h = lines.length * size * 1.25 + 0.08 * m;
  return { w, h, size };
}

/** Rough text width: CJK glyphs are square, Latin ~0.6 em. */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[⺀-￿]/.test(ch) ? 1 : 0.6;
  return w * size;
}
