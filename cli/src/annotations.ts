/**
 * Plan annotations (dimension / text_note / tag) for `bimdown render`.
 *
 * Dimensions resolve their `start_ref` / `end_ref` against the level's
 * elements (same rules as the editor: location line projection, line ends,
 * wall faces, centres), so a rendered dimension follows a moved wall even if
 * the stored points are stale. Tags read their text from the host element.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from './utils/csv.js';
import { parseGeoJsonFile } from './utils/geojson.js';
import { GEOJSON_FILE_NAMES } from './schema/registry.js';
import { UNIT_TO_M } from './utils/units.js';
import { parseDimensionRef } from './validate/annotations.js';

export interface Pt { x: number; y: number }

export type IndexedElement =
  | { kind: 'line'; table: string; start: Pt; end: Pt; thickness: number; attrs: Record<string, string> }
  | { kind: 'point'; table: string; pos: Pt; attrs: Record<string, string> }
  | { kind: 'polygon'; table: string; vertices: Pt[]; attrs: Record<string, string> }
  /** door / window: opening edges along the host wall */
  | { kind: 'opening'; table: string; start: Pt; end: Pt; thickness: number; attrs: Record<string, string> }
  | { kind: 'space'; table: string; pos: Pt; vertices?: Pt[]; area?: number; attrs: Record<string, string> };

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function projectOntoLine(p: Pt, a: Pt, b: Pt): Pt {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < 1e-12) return a;
  return add(a, mul(d, dot(sub(p, a), d) / l2));
}

function shoelace(v: Pt[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function centroid(v: Pt[]): Pt {
  const a = shoelace(v);
  if (Math.abs(a) < 1e-10) return mul(v.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / v.length);
  let cx = 0, cy = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    const c = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function csvRows(dir: string, table: string): Record<string, string>[] {
  const p = join(dir, `${table}.csv`);
  if (!existsSync(p)) return [];
  try { return readCsv(p).rows; } catch { return []; }
}

/** Index every element of a level (plus global/) by id for annotation lookups. */
export function indexLevelElements(levelPath: string, globalPath: string): Map<string, IndexedElement> {
  const out = new Map<string, IndexedElement>();
  for (const dir of [globalPath, levelPath]) {
    for (const [table, fileBase] of Object.entries(GEOJSON_FILE_NAMES)) {
      if (table === 'space') continue;
      const path = join(dir, `${fileBase}.geojson`);
      if (!existsSync(path)) continue;
      const attrsById = new Map(csvRows(dir, table).map((r) => [r.id, r]));
      let fc;
      try { fc = parseGeoJsonFile(path); } catch { continue; }
      for (const f of fc.features) {
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const attrs = attrsById.get(id) ?? { id };
        const g = f.geometry;
        if (g.type === 'LineString' && g.coordinates.length >= 2) {
          const a = g.coordinates[0], b = g.coordinates[g.coordinates.length - 1];
          const t = parseFloat(attrs.thickness ?? '');
          out.set(id, { kind: 'line', table, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: Number.isFinite(t) ? t : 0, attrs });
        } else if (g.type === 'Point') {
          out.set(id, { kind: 'point', table, pos: { x: g.coordinates[0], y: g.coordinates[1] }, attrs });
        } else if (g.type === 'Polygon' && g.coordinates[0]?.length >= 3) {
          const ring = g.coordinates[0].map((c) => ({ x: c[0], y: c[1] }));
          const last = ring[ring.length - 1];
          if (last.x === ring[0].x && last.y === ring[0].y) ring.pop();
          out.set(id, { kind: 'polygon', table, vertices: ring, attrs });
        }
      }
    }
  }
  for (const r of csvRows(globalPath, 'grid')) {
    const [sx, sy, ex, ey] = [r.start_x, r.start_y, r.end_x, r.end_y].map(Number);
    if ([sx, sy, ex, ey].every(Number.isFinite)) {
      out.set(r.id, { kind: 'line', table: 'grid', start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: 0, attrs: r });
    }
  }
  // Hosted openings: edges along the host wall
  for (const table of ['door', 'window']) {
    for (const r of csvRows(levelPath, table)) {
      const host = out.get(r.host_id ?? '');
      const pos = parseFloat(r.position ?? '');
      const width = parseFloat(r.width ?? '');
      if (!host || host.kind !== 'line' || !Number.isFinite(pos) || !Number.isFinite(width)) continue;
      const d = sub(host.end, host.start);
      const l = len(d);
      if (l < 1e-9) continue;
      const u = mul(d, 1 / l);
      const c = add(host.start, mul(u, pos));
      out.set(r.id, { kind: 'opening', table, start: sub(c, mul(u, width / 2)), end: add(c, mul(u, width / 2)), thickness: host.thickness, attrs: r });
    }
  }
  // Rooms: seed + the polygon build wrote to space.geojson; tags show its
  // net area (at the wall faces), like the editor
  const polys = new Map<string, Pt[]>();
  const netAreas = new Map<string, number>();
  const spacePath = join(levelPath, 'space.geojson');
  if (existsSync(spacePath)) {
    try {
      for (const f of parseGeoJsonFile(spacePath).features) {
        if (f.geometry.type !== 'Polygon') continue;
        const ring = f.geometry.coordinates[0].map((c) => ({ x: c[0], y: c[1] }));
        const last = ring[ring.length - 1];
        if (ring.length && last.x === ring[0].x && last.y === ring[0].y) ring.pop();
        polys.set(String(f.properties.id), ring);
        if (typeof f.properties.net_area === 'number') netAreas.set(String(f.properties.id), f.properties.net_area);
      }
    } catch { /* no polygons */ }
  }
  for (const r of csvRows(levelPath, 'space')) {
    const x = parseFloat(r.x ?? ''), y = parseFloat(r.y ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const vertices = polys.get(r.id);
    out.set(r.id, { kind: 'space', table: 'space', pos: { x, y }, vertices, area: netAreas.get(r.id) ?? (vertices ? Math.abs(shoelace(vertices)) : undefined), attrs: r });
  }
  return out;
}

/** Anchor point of an element: where a tag sits and what a bare `<id>` dimension reference means for non-lines. */
export function elementAnchor(el: IndexedElement): Pt {
  switch (el.kind) {
    case 'line': case 'opening': return mid(el.start, el.end);
    case 'point': case 'space': return el.pos;
    case 'polygon': return centroid(el.vertices);
  }
}

/** Resolve one dimension end. Returns `stored` when the reference is empty or unresolvable. */
export function resolveDimensionPoint(ref: string, stored: Pt, index: Map<string, IndexedElement>): Pt {
  const r = ref.trim();
  if (!r) return stored;
  const { id, anchor } = parseDimensionRef(r);
  const el = index.get(id);
  if (!el) return stored;
  if (el.kind === 'line' || el.kind === 'opening') {
    if (anchor === 'start') return el.start;
    if (anchor === 'end') return el.end;
    if (anchor === 'center') return mid(el.start, el.end);
    if (el.kind === 'opening') return mid(el.start, el.end);
    let a = el.start, b = el.end;
    if (anchor === 'left' || anchor === 'right') {
      const d = sub(b, a);
      const l = len(d);
      if (l > 1e-9) {
        const n = mul({ x: -d.y / l, y: d.x / l }, (anchor === 'left' ? 1 : -1) * el.thickness / 2);
        a = add(a, n); b = add(b, n);
      }
    }
    return projectOntoLine(stored, a, b);
  }
  return elementAnchor(el);
}

export interface DimensionGeometry {
  /** Dimension line ends (on the line `offset` away). */
  d1: Pt; d2: Pt;
  /** Measured value (≥ 0). */
  value: number;
  /** Unit measurement direction and its left normal. */
  u: Pt; n: Pt;
}

/** Dimension line for measured points p1 → p2. `direction` in degrees, null = aligned. */
export function dimensionGeometry(p1: Pt, p2: Pt, direction: number | null, offset: number): DimensionGeometry | null {
  let u: Pt;
  if (direction !== null && Number.isFinite(direction)) {
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
  return { d1, d2, value: Math.abs(signed), u, n };
}

/** Drafting text for a length in project units: mm for metric, feet-inches for imperial. */
export function formatDimension(value: number, units: string): string {
  if (units === 'm') return String(Math.round(value * 1000));
  if (units === 'mm') return String(Math.round(value));
  const totalIn = units === 'ft' ? value * 12 : value;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round((totalIn - ft * 12) * 4) / 4;
  if (inch >= 12) { ft += 1; inch -= 12; }
  return ft > 0 ? `${ft}'-${inch}"` : `${inch}"`;
}

/** Area text in project units, e.g. "12.35 m²". */
export function formatArea(area: number, units: string): string {
  return `${area.toFixed(units === 'mm' ? 0 : 2)} ${units}²`;
}

const fmt = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(3)).toString() : '0');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Size descriptor of a host: door/window width×height, wall thickness, section size. */
function sizeText(el: IndexedElement, units: string): string {
  const a = el.attrs;
  const f = (v: string | undefined) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? formatDimension(n, units) : '';
  };
  if (a.width && a.height) return `${f(a.width)}×${f(a.height)}`;
  if (a.size_x && a.size_y) return `${f(a.size_x)}×${f(a.size_y)}`;
  if (a.thickness) return f(a.thickness);
  if (a.width) return f(a.width);
  return '';
}

/** Lines of text a tag shows for its host. */
export function tagLines(el: IndexedElement, content: string, units: string): string[] {
  const a = el.attrs;
  const number = (a.number ?? '').trim();
  const name = (a.name ?? '').trim();
  const area = el.kind === 'space' && el.area !== undefined ? formatArea(el.area, units) : '';
  switch (content || 'auto') {
    case 'number': return [number || a.id];
    case 'name': return [name || number || a.id];
    case 'type': return [(a.type_name ?? a.type_id ?? a.type ?? '').trim() || sizeText(el, units) || a.id];
    case 'size': return [sizeText(el, units) || a.id];
    case 'area': return [area || '—'];
    default:
      if (el.kind === 'space') return [name, number, area].filter(Boolean).length ? [name, number, area].filter(Boolean) : [a.id];
      if (el.table === 'door' || el.table === 'window') return [number || sizeText(el, units) || a.id];
      return [number || name || a.id];
  }
}

/** Default (unpinned) tag position: room seed, beside a door/window, element anchor. */
export function defaultTagPosition(el: IndexedElement, m: number): Pt {
  if (el.kind === 'opening') {
    const d = sub(el.end, el.start);
    const l = len(d) || 1;
    const n = { x: -d.y / l, y: d.x / l };
    return add(mid(el.start, el.end), mul(n, el.thickness / 2 + 0.35 * m));
  }
  return elementAnchor(el);
}

export interface AnnotationSvg {
  parts: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * Render a level's annotations as SVG fragments in plan coordinates (the
 * caller wraps them in the usual `scale(1,-1)` group; text is flipped back
 * upright here).
 */
export function renderAnnotations(levelPath: string, globalPath: string, units: string): AnnotationSvg {
  const parts: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p: Pt, r = 0) => {
    minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
  };
  const dims = csvRows(levelPath, 'dimension');
  const notes = csvRows(levelPath, 'text_note');
  const tags = csvRows(levelPath, 'tag');
  if (dims.length + notes.length + tags.length === 0) return { parts, bounds: null };

  const m = 1 / (UNIT_TO_M[units] ?? 1); // one metre in project units
  const index = indexLevelElements(levelPath, globalPath);
  const ink = '#1d3557';
  const text = (p: Pt, s: string, size: number, angleDeg = 0, weight = 400) => {
    // Upright text in a Y-up group: flip about the anchor, then rotate.
    const tf = `translate(${fmt(p.x)},${fmt(p.y)}) scale(1,-1) rotate(${fmt(-angleDeg)})`;
    return `    <text transform="${tf}" font-size="${fmt(size)}" font-family="sans-serif" font-weight="${weight}" fill="${ink}" text-anchor="middle" dominant-baseline="central">${esc(s)}</text>`;
  };

  for (const r of dims) {
    const stored1 = { x: Number(r.start_x), y: Number(r.start_y) };
    const stored2 = { x: Number(r.end_x), y: Number(r.end_y) };
    if (![stored1.x, stored1.y, stored2.x, stored2.y].every(Number.isFinite)) continue;
    const p1 = resolveDimensionPoint(r.start_ref ?? '', stored1, index);
    const p2 = resolveDimensionPoint(r.end_ref ?? '', stored2, index);
    const dirRaw = (r.direction ?? '').trim();
    const g = dimensionGeometry(p1, p2, dirRaw === '' ? null : Number(dirRaw), Number(r.offset) || 0);
    if (!g) continue;
    const sw = 0.02 * m, tick = 0.12 * m, over = 0.1 * m, gap = 0.08 * m;
    const ext = (p: Pt, d: Pt) => {
      const v = sub(d, p);
      const l = len(v);
      if (l < gap) return '';
      const dir = mul(v, 1 / l);
      const a = add(p, mul(dir, gap)), b = add(d, mul(dir, over));
      return `    <line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="${ink}" stroke-width="${fmt(sw)}" />`;
    };
    const slash = mul(add(g.u, g.n), tick / Math.SQRT2);
    const ticks = [g.d1, g.d2].map((d) => {
      const a = sub(d, slash), b = add(d, slash);
      return `    <line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="${ink}" stroke-width="${fmt(sw * 2)}" />`;
    });
    let angle = Math.atan2(g.u.y, g.u.x) * 180 / Math.PI;
    if (angle > 90.01 || angle <= -89.99) angle += 180;
    const label = (r.text ?? '').trim() || formatDimension(g.value, units);
    const up = { x: -Math.sin(angle * Math.PI / 180), y: Math.cos(angle * Math.PI / 180) };
    const tp = add(mid(g.d1, g.d2), mul(up, 0.16 * m));
    parts.push(`    <g data-annotation="dimension" id="${esc(r.id)}">`,
      ext(p1, g.d1), ext(p2, g.d2),
      `    <line x1="${fmt(g.d1.x)}" y1="${fmt(g.d1.y)}" x2="${fmt(g.d2.x)}" y2="${fmt(g.d2.y)}" stroke="${ink}" stroke-width="${fmt(sw)}" />`,
      ...ticks, text(tp, label, 0.22 * m, angle), '    </g>');
    for (const p of [p1, p2, g.d1, g.d2, tp]) grow(p, 0.2 * m);
  }

  for (const r of notes) {
    const p = { x: Number(r.x), y: Number(r.y) };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !r.text) continue;
    const size = Number(r.size) || 0.25 * m;
    const rot = Number(r.rotation) || 0;
    const lines = r.text.split('\\n');
    const a = rot * Math.PI / 180;
    parts.push(`    <g data-annotation="text_note" id="${esc(r.id)}">`);
    lines.forEach((line, i) => {
      const dy = ((lines.length - 1) / 2 - i) * size * 1.25;
      const q = { x: p.x - Math.sin(a) * dy, y: p.y + Math.cos(a) * dy };
      parts.push(text(q, line, size, rot));
    });
    parts.push('    </g>');
    grow(p, size * Math.max(...lines.map((l) => l.length)) * 0.6);
  }

  for (const r of tags) {
    const host = index.get(r.host_id ?? '');
    if (!host) continue;
    const pinned = (r.x ?? '') !== '' && (r.y ?? '') !== '';
    const pos = pinned ? { x: Number(r.x), y: Number(r.y) } : defaultTagPosition(host, m);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
    const lines = tagLines(host, r.content ?? '', units);
    const room = host.kind === 'space';
    const size = (room ? 0.24 : 0.2) * m;
    const w = Math.max(...lines.map((l) => l.length)) * size * 0.62 + 0.16 * m;
    const h = lines.length * size * 1.25 + 0.08 * m;
    parts.push(`    <g data-annotation="tag" id="${esc(r.id)}">`);
    const anchor = elementAnchor(host);
    if (pinned && len(sub(anchor, pos)) > 0.6 * m) {
      parts.push(`    <line x1="${fmt(anchor.x)}" y1="${fmt(anchor.y)}" x2="${fmt(pos.x)}" y2="${fmt(pos.y)}" stroke="${ink}" stroke-width="${fmt(0.015 * m)}" />`);
    }
    if (!room) {
      parts.push(`    <rect x="${fmt(pos.x - w / 2)}" y="${fmt(pos.y - h / 2)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(0.04 * m)}" fill="white" stroke="${ink}" stroke-width="${fmt(0.015 * m)}" />`);
    }
    lines.forEach((line, i) => {
      const dy = ((lines.length - 1) / 2 - i) * size * 1.25;
      parts.push(text({ x: pos.x, y: pos.y + dy }, line, i === 0 && room ? size * 1.1 : size, 0, i === 0 ? 600 : 400));
    });
    parts.push('    </g>');
    grow(pos, Math.max(w, h));
  }

  return { parts: parts.filter(Boolean), bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null };
}
