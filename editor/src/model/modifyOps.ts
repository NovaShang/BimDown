/**
 * Modify operations on any selection (mixed categories) — pure patch
 * builders behind the Rotate / Mirror / Array / Align / Offset tools:
 *
 *   transformPatch  — rotate / mirror / move the selection, or copies of it;
 *                     walls joined to moved walls keep their joins
 *   arrayPatch      — n copies along a list of transforms, optionally as
 *                     instances of one model group
 *   alignDelta      — translation that puts an element line onto a reference
 *   offsetPatch     — a line element shifted sideways (or a copy of it)
 *
 * Pinned elements never move (a copy of them is fine).
 */
import type { CanonicalElement, LineElement, Point, SpatialLineElement } from './elements.ts';

type AnyLine = LineElement | SpatialLineElement;
import { expandCopySet, cloneElements, gridNames, type NumberPool } from './copySet.ts';
import { isPinned } from './pins.ts';
import { applyXform, isMirror, rotationAbout, transformElements, translation, type Xform, elementsBounds, boundsCenter } from './transform.ts';
import { applyReshapeJoins, findWallJoins, isJoinable, wallFrame } from '../geometry/wallJoins.ts';
import { svgArcToCenterParams } from '../geometry/arc.ts';
import { parseRef, formatRef } from '../annotation/geometry.ts';
import { generateId } from './ids.ts';
import { createGroupPatch, GROUP_TABLE } from './groups.ts';

export type Patch = Map<string, CanonicalElement | null>;

/** The selection grown by its dependants, minus what is pinned (and what rides on it). */
export function movingSet(elements: ReadonlyMap<string, CanonicalElement>, ids: Iterable<string>): Set<string> {
  const raw = [...ids].filter(id => !isPinned(elements.get(id)));
  const set = expandCopySet(elements, raw);
  for (const id of [...set]) {
    const el = elements.get(id)!;
    if (isPinned(el)) set.delete(id);
  }
  return set;
}

/** Centre of the selection's plan extent. */
export function selectionCenter(elements: ReadonlyMap<string, CanonicalElement>, ids: Iterable<string>): Point | null {
  const els: CanonicalElement[] = [];
  for (const id of ids) { const el = elements.get(id); if (el) els.push(el); }
  const b = elementsBounds(els);
  return b ? boundsCenter(b) : null;
}

/** Dimension ends stuck to the start / end of a reversed wall (or of its doors) swap anchors. */
function swapEndAnchors(elements: ReadonlyMap<string, CanonicalElement>, reversed: ReadonlySet<string>, patch: Patch) {
  if (reversed.size === 0) return;
  for (const el of elements.values()) {
    if (el.tableName !== 'dimension') continue;
    const cur = patch.get(el.id) ?? el;
    if (!cur) continue;
    let attrs: Record<string, string> | null = null;
    for (const side of ['start_ref', 'end_ref'] as const) {
      const { id, anchor } = parseRef(cur.attrs[side]);
      if (!id || !reversed.has(id) || (anchor !== 'start' && anchor !== 'end')) continue;
      attrs ??= { ...cur.attrs };
      attrs[side] = formatRef(id, anchor === 'start' ? 'end' : 'start');
    }
    if (attrs) patch.set(el.id, { ...cur, attrs });
  }
}

/** Ids whose start→end the transform reversed (sided walls and the openings on them). */
function reversedIds(before: ReadonlyMap<string, CanonicalElement>, after: ReadonlyMap<string, CanonicalElement>, T: Xform): Set<string> {
  const out = new Set<string>();
  if (!isMirror(T)) return out;
  for (const [id, el] of after) {
    const old = before.get(id);
    if (!old || (old.geometry !== 'line' && old.geometry !== 'spatial_line') || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    const s = applyXform(T, old.start);
    if (Math.hypot(s.x - el.end.x, s.y - el.end.y) < Math.hypot(s.x - el.start.x, s.y - el.start.y)) out.add(id);
  }
  return out;
}

/**
 * Transform the selection in place (`copy` = false) or add transformed copies.
 * Returns the patch and the ids to select afterwards (raw).
 */
export function transformPatch(
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  T: Xform,
  copy: boolean,
  numbers?: NumberPool,
): { patch: Patch; select: string[] } {
  const selected = [...ids].filter(id => elements.has(id));
  if (!copy) {
    const set = movingSet(elements, selected);
    const moved = transformElements(elements, set, T);
    const patch: Patch = new Map(moved);
    // Walls joined to moved walls keep their corners / tees
    const next = new Map(elements);
    for (const [id, el] of moved) next.set(id, el);
    const joins = findWallJoins(elements, set).filter(j => !set.has(j.otherId) && !isPinned(elements.get(j.otherId)) && j.kind !== 'abut');
    if (joins.length) {
      for (const id of set) {
        const before = elements.get(id);
        if (!isJoinable(before)) continue;
        const own = joins.filter(j => j.driverId === id);
        if (own.length === 0) continue;
        for (const t of applyReshapeJoins(elements, next, before!, own)) patch.set(t, next.get(t)!);
      }
    }
    swapEndAnchors(elements, reversedIds(elements, moved, T), patch);
    return { patch, select: selected.filter(id => set.has(id) || isPinned(elements.get(id))) };
  }
  const set = expandCopySet(elements, selected);
  const taken = new Set(elements.keys());
  const { clones, idMap } = cloneElements(elements, set, { taken, keepOutsideRefs: true, numbers });
  // A door copied without its wall can't follow a rotation: leave it out
  for (const [src, nid] of idMap) {
    const el = elements.get(src)!;
    if (el.hostId && !set.has(el.hostId) && el.tableName !== 'connector') { clones.delete(nid); idMap.delete(src); }
  }
  const placed = transformElements(clones, clones.keys(), T);
  const patch: Patch = new Map(placed);
  swapEndAnchors(clones, reversedIds(clones, placed, T), patch);
  const select = selected.map(id => idMap.get(id)).filter((x): x is string => !!x);
  return { patch, select };
}

/**
 * Copies of the selection, one per transform. With `group`, the selection
 * becomes a model group (unless it already is one) and every copy an
 * instance of it.
 */
export function arrayPatch(
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  transforms: readonly Xform[],
  group?: { name: string },
  numbers?: NumberPool,
): { patch: Patch; select: string[] } {
  let source: Map<string, CanonicalElement> = new Map(elements);
  const patch: Patch = new Map();
  let selected = [...ids].filter(id => elements.has(id));
  if (group && !selected.some(id => elements.get(id)!.tableName === GROUP_TABLE)) {
    const taken = new Set(elements.keys());
    const g = createGroupPatch(elements, selected, group.name, taken);
    if (g) {
      for (const [id, el] of g.patch) { patch.set(id, el); if (el) source.set(id, el); else source.delete(id); }
      selected = [g.groupId];
    }
  }
  const set = expandCopySet(source, selected);
  const taken = new Set(source.keys());
  const names = gridNames(source.values()); // copies 2, 3, 4 of grid 1
  const select: string[] = [];
  for (const T of transforms) {
    // Instances of one group stay identical: no renumbering there
    const { clones, idMap } = cloneElements(source, set, { taken, keepOutsideRefs: true, numbers: group ? undefined : numbers, gridNames: names });
    for (const [src, nid] of idMap) {
      const el = source.get(src)!;
      if (el.hostId && !set.has(el.hostId) && el.tableName !== 'connector') { clones.delete(nid); idMap.delete(src); }
    }
    const placed = transformElements(clones, clones.keys(), T);
    for (const [id, el] of placed) patch.set(id, el);
    for (const id of selected) { const n = idMap.get(id); if (n) select.push(n); }
  }
  return { patch, select };
}

/** Linear array: copy i (1..count-1) at i·step; `fit` = `vector` spans first → last. */
export function linearArrayTransforms(vector: Point, count: number, fit: boolean): Xform[] {
  const n = Math.max(2, Math.floor(count));
  const step = fit ? { x: vector.x / (n - 1), y: vector.y / (n - 1) } : vector;
  const out: Xform[] = [];
  for (let i = 1; i < n; i++) out.push(translation(step.x * i, step.y * i));
  return out;
}

/** Radial array: `count` items over `angle` degrees about `center` (360 = full circle). */
export function radialArrayTransforms(center: Point, count: number, angle: number): Xform[] {
  const n = Math.max(2, Math.floor(count));
  const full = Math.abs(Math.abs(angle) - 360) < 1e-9;
  const step = full ? angle / n : angle / (n - 1);
  const out: Xform[] = [];
  for (let i = 1; i < n; i++) out.push(rotationAbout(center, step * i));
  return out;
}

// ─── Align ──────────────────────────────────────────────────────────────────

/** A straight line an element offers to Align: centreline, faces, edges. */
export interface AlignLine { p: Point; d: Point; kind: 'center' | 'face' | 'edge' }

/** Candidate lines of an element (walls: centreline + both faces; rect columns: edges + centre lines). */
export function alignLines(el: CanonicalElement): AlignLine[] {
  if ((el.geometry === 'line' || el.geometry === 'spatial_line') && !el.arc && !el.hostId) {
    const f = wallFrame(el);
    if (!f) return [];
    const out: AlignLine[] = [{ p: el.start, d: f.u, kind: 'center' }];
    const hw = el.strokeWidth / 2;
    if (el.tableName !== 'grid' && hw > 1e-6) {
      for (const s of [1, -1]) out.push({ p: { x: el.start.x + f.n.x * hw * s, y: el.start.y + f.n.y * hw * s }, d: f.u, kind: 'face' });
    }
    return out;
  }
  if (el.geometry === 'point' && el.tableName !== 'tag' && el.tableName !== 'text_note' && el.tableName !== 'space') {
    const r = (parseFloat(el.attrs.rotation ?? '') || 0) * Math.PI / 180;
    const u = { x: Math.cos(r), y: Math.sin(r) }, n = { x: -u.y, y: u.x };
    const hw = el.width / 2, hh = el.height / 2;
    const c = el.position;
    const at = (a: number, b: number) => ({ x: c.x + u.x * a + n.x * b, y: c.y + u.y * a + n.y * b });
    return [
      { p: c, d: u, kind: 'center' }, { p: c, d: n, kind: 'center' },
      { p: at(0, hh), d: u, kind: 'edge' }, { p: at(0, -hh), d: u, kind: 'edge' },
      { p: at(hw, 0), d: n, kind: 'edge' }, { p: at(-hw, 0), d: n, kind: 'edge' },
    ];
  }
  if (el.geometry === 'polygon') {
    const out: AlignLine[] = [];
    const v = el.vertices;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 1e-6) out.push({ p: a, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, kind: 'edge' });
    }
    return out;
  }
  return [];
}

function distToLine(p: Point, l: AlignLine): number {
  return Math.abs((p.x - l.p.x) * -l.d.y + (p.y - l.p.y) * l.d.x);
}

/** The candidate line of `el` nearest to `pick`. */
export function nearestAlignLine(el: CanonicalElement, pick: Point): AlignLine | null {
  let best: AlignLine | null = null, bestD = Infinity;
  for (const l of alignLines(el)) {
    const d = distToLine(pick, l);
    if (d < bestD - 1e-9) { bestD = d; best = l; }
  }
  return best;
}

/** Translation bringing `target` onto `ref` (null unless parallel within ~0.5°). */
export function alignDelta(ref: AlignLine, target: AlignLine): Point | null {
  const cross = ref.d.x * target.d.y - ref.d.y * target.d.x;
  if (Math.abs(cross) > 0.01) return null;
  const n = { x: -ref.d.y, y: ref.d.x };
  const dist = (ref.p.x - target.p.x) * n.x + (ref.p.y - target.p.y) * n.y;
  if (Math.abs(dist) < 1e-9) return null;
  return { x: n.x * dist, y: n.y * dist };
}

// ─── Offset ─────────────────────────────────────────────────────────────────

/** Can `el` be offset (a free straight or arc line: walls, beams, pipes, grids, …)? */
export function canOffset(el: CanonicalElement | undefined | null): el is AnyLine {
  return !!el && (el.geometry === 'line' || el.geometry === 'spatial_line') && !el.hostId && el.tableName !== 'dimension';
}

/** Signed side of `p` relative to `el` (+1 left of start→end, −1 right; arcs: +1 outside). */
export function offsetSide(el: AnyLine, p: Point): 1 | -1 {
  if (el.arc) {
    const c = svgArcToCenterParams(el.start, el.end, el.arc);
    return Math.hypot(p.x - c.cx, p.y - c.cy) >= c.rx ? 1 : -1;
  }
  const f = wallFrame(el);
  if (!f) return 1;
  return (p.x - el.start.x) * f.n.x + (p.y - el.start.y) * f.n.y >= 0 ? 1 : -1;
}

/** `el` moved `dist` sideways (side from `offsetSide`). Arcs stay concentric. */
export function offsetElement<T extends AnyLine>(el: T, dist: number, side: 1 | -1): T | null {
  if (el.arc) {
    const c = svgArcToCenterParams(el.start, el.end, el.arc);
    const r = c.rx + side * dist;
    if (r <= 1e-6) return null;
    const scale = (p: Point) => ({ x: c.cx + (p.x - c.cx) * r / c.rx, y: c.cy + (p.y - c.cy) * r / c.rx });
    return { ...el, start: scale(el.start), end: scale(el.end), arc: { ...el.arc, rx: r, ry: r } };
  }
  const f = wallFrame(el);
  if (!f) return null;
  const v = { x: f.n.x * dist * side, y: f.n.y * dist * side };
  return { ...el, start: { x: el.start.x + v.x, y: el.start.y + v.y }, end: { x: el.end.x + v.x, y: el.end.y + v.y } };
}

/**
 * Offset patch. Copy: a new element (no doors). Move of a straight element is
 * a translation (the caller dispatches MOVE_ELEMENTS so joins follow); this
 * returns it as `move`.
 */
export function offsetPatch(
  elements: ReadonlyMap<string, CanonicalElement>,
  id: string,
  dist: number,
  side: 1 | -1,
  copy: boolean,
): { patch: Patch; select: string[] } | { move: Point } | null {
  const el = elements.get(id);
  if (!canOffset(el)) return null;
  const shifted = offsetElement(el, dist, side);
  if (!shifted) return null;
  if (copy) {
    const nid = generateId(el.tableName, new Set(elements.keys()));
    const attrs: Record<string, string> = { ...el.attrs, id: nid };
    delete attrs.group_id;
    delete attrs.pinned;
    if ('from' in attrs) attrs.from = '';
    if ('to' in attrs) attrs.to = '';
    if (el.tableName === 'grid') attrs.number = nextGridNumber(elements, el.attrs.number ?? '');
    return { patch: new Map([[nid, { ...shifted, id: nid, attrs }]]), select: [nid] };
  }
  if (isPinned(el)) return null;
  if (!el.arc) return { move: { x: shifted.start.x - el.start.x, y: shifted.start.y - el.start.y } };
  return { patch: new Map([[id, shifted]]), select: [id] };
}

/** Next grid label after `n` not in use (A → B, 3 → 4). */
export function nextGridNumber(elements: ReadonlyMap<string, CanonicalElement>, n: string): string {
  const used = new Set<string>();
  for (const el of elements.values()) if (el.tableName === 'grid') used.add(el.attrs.number ?? '');
  const bump = (s: string): string => {
    if (/^\d+$/.test(s)) return String(parseInt(s, 10) + 1);
    if (/^[A-Z]$/.test(s)) return s === 'Z' ? 'AA' : String.fromCharCode(s.charCodeAt(0) + 1);
    return s + "'";
  };
  let c = bump(n || 'A');
  for (let i = 0; i < 200 && used.has(c); i++) c = bump(c);
  return c;
}
