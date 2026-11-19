/**
 * Rigid plan transforms (rotate / mirror / translate) of any element set, as
 * used by the modify tools, the clipboard, arrays and model groups.
 *
 * An element is transformed by its own geometry plus the attributes that
 * carry an orientation:
 *   - point `rotation`, text_note `rotation`, model_group `rotation` + `mirrored`;
 *   - dimension `direction` (and `offset`, whose side flips in a mirror);
 *   - arcs (rotation, sweep);
 *   - walls are reversed in a mirror so their exterior (left) side is the
 *     mirror image of the original's exterior side (layer order preserved);
 *   - hosted doors / windows / openings re-seat on their transformed host
 *     (position measured from the host's new start) and a door's hinge and
 *     swing follow the physical mirror image;
 *   - connector offsets (host-local) flip their Y when the host is mirrored.
 * Hosted children whose host is not in the set are left alone.
 */
import type { CanonicalElement, LineElement, Point, PointElement, PolygonElement, SpatialLineElement } from './elements.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import { JOIN_TABLES, wallLength } from '../geometry/wallJoins.ts';
import { isCsvOnlyTable } from './serialize.ts';

/** x' = a·x + c·y + tx, y' = b·x + d·y + ty */
export interface Xform { a: number; b: number; c: number; d: number; tx: number; ty: number }

export const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export function translation(dx: number, dy: number): Xform {
  return { a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy };
}

/** Rotation by `deg` (CCW) about `center`. */
export function rotationAbout(center: Point, deg: number): Xform {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return {
    a: cos, b: sin, c: -sin, d: cos,
    tx: center.x - cos * center.x + sin * center.y,
    ty: center.y - sin * center.x - cos * center.y,
  };
}

/** Reflection across the line through `p` with direction `dir`. */
export function mirrorAcross(p: Point, dir: Point): Xform {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len, uy = dir.y / len;
  const a = ux * ux - uy * uy, b = 2 * ux * uy;
  // [a b; b -a]
  return { a, b, c: b, d: -a, tx: p.x - a * p.x - b * p.y, ty: p.y - b * p.x + a * p.y };
}

/** A ∘ B (apply B first). */
export function compose(A: Xform, B: Xform): Xform {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    tx: A.a * B.tx + A.c * B.ty + A.tx,
    ty: A.b * B.tx + A.d * B.ty + A.ty,
  };
}

export function invert(T: Xform): Xform {
  const det = T.a * T.d - T.b * T.c;
  const a = T.d / det, b = -T.b / det, c = -T.c / det, d = T.a / det;
  return { a, b, c, d, tx: -(a * T.tx + c * T.ty), ty: -(b * T.tx + d * T.ty) };
}

export function applyXform(T: Xform, p: Point): Point {
  return { x: T.a * p.x + T.c * p.y + T.tx, y: T.b * p.x + T.d * p.y + T.ty };
}

export function applyDir(T: Xform, v: Point): Point {
  return { x: T.a * v.x + T.c * v.y, y: T.b * v.x + T.d * v.y };
}

export function isMirror(T: Xform): boolean {
  return T.a * T.d - T.b * T.c < 0;
}

export function isIdentity(T: Xform): boolean {
  return Math.abs(T.a - 1) < 1e-12 && Math.abs(T.b) < 1e-12 && Math.abs(T.c) < 1e-12 && Math.abs(T.d - 1) < 1e-12
    && Math.abs(T.tx) < 1e-12 && Math.abs(T.ty) < 1e-12;
}

/** Normalise degrees to (-180, 180], rounded to 1e-4. */
export function normDeg(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  d = Math.round(d * 1e4) / 1e4;
  return d === -180 ? 180 : d === 0 ? 0 : d;
}

/** The direction `deg` (CCW from +X) after the transform. */
export function transformAngle(T: Xform, deg: number): number {
  const r = deg * Math.PI / 180;
  const v = applyDir(T, { x: Math.cos(r), y: Math.sin(r) });
  return normDeg(Math.atan2(v.y, v.x) * 180 / Math.PI);
}

/** Rotation part of T in degrees (for a mirror: of its rotation after the flip). */
export function xformAngle(T: Xform): number {
  return normDeg(Math.atan2(T.b, T.a) * 180 / Math.PI);
}

const fmt = (n: number) => String(Math.round(n * 1e4) / 1e4);

/** Tables whose left/right side means something (layer order): reversed in a mirror. */
const SIDED_TABLES = JOIN_TABLES;

/** Point tables that store a plan rotation (GeoJSON property or CSV column). */
function hasRotation(el: PointElement): boolean {
  if (el.tableName === 'text_note' || el.tableName === 'model_group' || el.tableName === 'mesh') return true;
  if (el.tableName === 'space' || el.tableName === 'tag' || el.tableName === 'connector') return false;
  return !isCsvOnlyTable(el.tableName);
}

function transformPoints(T: Xform, pts: Point[], mirror: boolean): Point[] {
  const out = pts.map(p => applyXform(T, p));
  return mirror ? out.reverse() : out;
}

/** One element, geometry and orientation attributes (hosted re-seating is done by `transformElements`). */
export function transformElement(el: CanonicalElement, T: Xform): CanonicalElement {
  const next = transformGeometry(el, T);
  // A mirrored stair is the other hand: its left railing becomes the right one
  if (isMirror(T) && el.tableName === 'railing' && (el.attrs.side === 'left' || el.attrs.side === 'right')) {
    return { ...next, attrs: { ...next.attrs, side: el.attrs.side === 'left' ? 'right' : 'left' } };
  }
  return next;
}

function transformGeometry(el: CanonicalElement, T: Xform): CanonicalElement {
  const mirror = isMirror(T);
  switch (el.geometry) {
    case 'line':
    case 'spatial_line': {
      let start = applyXform(T, el.start), end = applyXform(T, el.end);
      let arc = el.arc;
      if (arc) arc = { ...arc, rotation: transformAngle(T, arc.rotation), sweep: mirror ? !arc.sweep : arc.sweep };
      const reverse = mirror && SIDED_TABLES.has(el.tableName) && !el.hostId;
      let next: LineElement | SpatialLineElement = { ...el, start, end, ...(arc ? { arc } : {}) };
      if (reverse) {
        [start, end] = [end, start];
        next = { ...next, start, end, ...(arc ? { arc: { ...arc, sweep: !arc.sweep } } : {}) };
        if (next.geometry === 'spatial_line') {
          const sp = next as SpatialLineElement;
          next = { ...sp, startZ: sp.endZ, endZ: sp.startZ };
        }
      }
      if (el.tableName === 'dimension') {
        const attrs = { ...el.attrs };
        const dir = parseFloat(attrs.direction ?? '');
        if (Number.isFinite(dir)) attrs.direction = fmt(transformAngle(T, dir));
        if (mirror) {
          const off = parseFloat(attrs.offset ?? '');
          if (Number.isFinite(off) && off !== 0) attrs.offset = fmt(-off);
        }
        next = { ...next, attrs };
      } else if (el.tableName === 'grid') {
        // Grid geometry is its CSV (gridBridge); nothing else to keep in sync.
      }
      return next;
    }
    case 'point': {
      const position = el.tableName === 'connector' ? el.position : applyXform(T, el.position);
      const attrs = { ...el.attrs };
      if ('x' in attrs && attrs.x !== '') attrs.x = fmt(position.x);
      if ('y' in attrs && attrs.y !== '') attrs.y = fmt(position.y);
      if (hasRotation(el)) {
        const r = parseFloat(attrs.rotation ?? '') || 0;
        const nr = transformAngle(T, r);
        if (nr !== 0 || (attrs.rotation ?? '') !== '') attrs.rotation = fmt(nr);
      }
      if (mirror && el.tableName === 'model_group') attrs.mirrored = attrs.mirrored === 'true' ? '' : 'true';
      return { ...el, position, attrs };
    }
    case 'polygon': {
      const poly = el as PolygonElement;
      // A mirror reverses the ring; it restarts at the old second vertex so the
      // first edge stays the first edge (extrusion roof profiles hang on it)
      // and per-edge values (roof edge_slopes) follow their edges.
      const out = poly.vertices.map(p => applyXform(T, p));
      const n = out.length;
      const vertices = mirror && n >= 3 ? [out[1], out[0], ...out.slice(2).reverse()] : out;
      let attrs = el.attrs;
      if (mirror && n >= 3 && attrs.edge_slopes) {
        const list = attrs.edge_slopes.split(';');
        if (list.length === n) attrs = { ...attrs, edge_slopes: list.map((_, j) => list[(n - j) % n]).join(';') };
      }
      return {
        ...poly,
        attrs,
        vertices,
        ...(poly.holes ? { holes: poly.holes.map(h => transformPoints(T, h, mirror)) } : {}),
      };
    }
  }
}

function isLineHost(el: CanonicalElement | undefined): el is LineElement {
  return !!el && (el.geometry === 'line' || el.geometry === 'spatial_line');
}

/** Hosted on a line by a `position` along it (door / window / opening). */
function seatsOnHost(el: CanonicalElement, host: CanonicalElement | undefined): boolean {
  // Stair runs and railings follow their stair as geometry, not by a position along it
  return !!el.hostId && el.geometry === 'line' && isLineHost(host) && el.tableName !== 'stair_run' && el.tableName !== 'railing';
}

const flipHinge = (v: string | undefined) => (v === 'end' ? 'start' : 'end');
const flipSwing = (v: string | undefined) => (v === 'right' ? 'left' : 'right');

/**
 * Transform the elements `ids` (raw ids, children already included) of
 * `elements`. Returns the transformed elements by id. Hosted children of a
 * transformed host re-seat on it; children whose host is not in the set are
 * skipped.
 */
export function transformElements(
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  T: Xform,
): Map<string, CanonicalElement> {
  const set = new Set<string>();
  for (const id of ids) if (elements.has(id)) set.add(id);
  const out = new Map<string, CanonicalElement>();
  const mirror = isMirror(T);
  // Hosts first
  for (const id of set) {
    const el = elements.get(id)!;
    const host = el.hostId ? elements.get(el.hostId) : undefined;
    if (seatsOnHost(el, host)) continue;
    if (el.tableName === 'connector') {
      if (!el.hostId || !set.has(el.hostId)) continue;
      if (!mirror) continue;
      const attrs = { ...el.attrs };
      for (const k of ['offset_y', 'dir_y']) {
        const v = parseFloat(attrs[k] ?? '');
        if (Number.isFinite(v) && v !== 0) attrs[k] = fmt(-v);
      }
      out.set(id, { ...el, attrs });
      continue;
    }
    out.set(id, transformElement(el, T));
  }
  // Doors / windows / openings: re-seat on the transformed host
  for (const id of set) {
    const el = elements.get(id)!;
    const oldHost = el.hostId ? elements.get(el.hostId) : undefined;
    if (!seatsOnHost(el, oldHost) || !set.has(el.hostId!)) continue;
    const newHost = out.get(el.hostId!);
    if (!isLineHost(newHost) || !isLineHost(oldHost)) continue;
    const reversed = mirror && SIDED_TABLES.has(oldHost.tableName);
    const ln = el as LineElement;
    const width = parseFloat(ln.attrs.width ?? '') || Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y) || 0.9;
    let pos = ln.locationParam ?? (parseFloat(ln.attrs.position ?? '') || 0);
    if (reversed) pos = wallLength(newHost) - pos;
    const { start, end } = resolveHostedGeometry(newHost, pos, width);
    const attrs: Record<string, string> = { ...ln.attrs, position: fmt(pos) };
    if (el.tableName === 'door') {
      if (reversed) attrs.hinge_position = flipHinge(attrs.hinge_position);
      if (mirror !== reversed) attrs.swing_side = flipSwing(attrs.swing_side);
    }
    out.set(id, { ...ln, start, end, locationParam: pos, attrs });
  }
  return out;
}

/** Plan bounding box of elements (geometry only; hosted children ride on their host). */
export function elementsBounds(els: Iterable<CanonicalElement>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: Point) => {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  };
  for (const el of els) {
    if (el.tableName === 'connector') continue;
    if (el.geometry === 'line' || el.geometry === 'spatial_line') { add(el.start); add(el.end); }
    else if (el.geometry === 'point') {
      if (el.tableName === 'tag' && (el.attrs.x ?? '') === '') continue;
      add(el.position);
    } else el.vertices.forEach(add);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function boundsCenter(b: { minX: number; minY: number; maxX: number; maxY: number }): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}
