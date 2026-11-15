/**
 * Which element a click picks when several lie under the pointer (Revit's
 * selection priority): the smaller, more specific one wins — doors and
 * windows over their wall, a curtain wall over the room behind it, a room
 * over the slab under it. Floors, roofs and ceilings are picked by their edge;
 * pressing inside them (or inside a room, away from its label) still selects
 * them on a click when nothing else is there, but a drag starts a box
 * selection instead of moving the host.
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';

/** Area hosts: selected by their edge, or by a click when nothing else is under the pointer. */
const AREA_HOSTS = new Set(['slab', 'structure_slab', 'roof', 'ceiling', 'foundation', 'mesh']);

const HOSTED = new Set(['door', 'window', 'opening']);
const ANNOTATION = new Set(['dimension', 'text_note', 'tag']);

export interface PickCandidate {
  sid: string;
  el: CanonicalElement;
  /** The pointer is on the element's label / marker (rooms: drag moves it). */
  onLabel?: boolean;
  /** Only an invisible pick area is under the pointer (a furniture box, a
   *  door bay): the element yields to anything drawn there, rooms aside. */
  pickAreaOnly?: boolean;
}

export interface RankedPick extends PickCandidate {
  rank: number;
  /** Picked from inside an area host or room: a click selects it, a drag box-selects. */
  soft: boolean;
}

function boxArea(el: CanonicalElement): number {
  switch (el.geometry) {
    case 'line':
    case 'spatial_line':
      return Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) * Math.max(el.strokeWidth, 0.01);
    case 'point':
      return Math.max(el.width * el.height, 1e-4);
    case 'polygon': {
      let s = 0;
      const v = el.vertices;
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) s += (v[j].x + v[i].x) * (v[j].y - v[i].y);
      return Math.abs(s / 2);
    }
  }
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Distance from `p` to a polygon's boundary. */
export function edgeDistance(el: CanonicalElement, p: Point): number {
  if (el.geometry !== 'polygon') return Infinity;
  let d = Infinity;
  const v = el.vertices;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) d = Math.min(d, segDist(p, v[j], v[i]));
  return d;
}

/** Lower is picked first. */
function rankOf(c: PickCandidate, p: Point, tol: number): { rank: number; soft: boolean } {
  const t = c.el.tableName;
  if (ANNOTATION.has(t)) return { rank: 0, soft: false };
  if (HOSTED.has(t)) return { rank: 1, soft: false };
  if (AREA_HOSTS.has(t)) {
    return edgeDistance(c.el, p) <= tol ? { rank: 4, soft: false } : { rank: 9, soft: true };
  }
  if (t === 'space') return c.onLabel ? { rank: 2, soft: false } : { rank: 8, soft: true };
  // Datums run along façades and through walls: the model element wins
  if (t === 'grid') return { rank: c.pickAreaOnly ? 7.5 : 7.2, soft: false };
  if (c.pickAreaOnly) return { rank: 7, soft: false };
  if (t === 'curtain_wall') return { rank: 3, soft: false };
  if (c.el.geometry === 'point') return { rank: 2, soft: false };
  if (c.el.geometry === 'line' || c.el.geometry === 'spatial_line') return { rank: 4, soft: false };
  return { rank: 5, soft: false };
}

/**
 * Candidates under the pointer (`p`, plan coordinates; `tol`: a few pixels in
 * plan units), most specific first; ties go to the smaller element.
 */
export function rankPicks(cands: readonly PickCandidate[], p: Point, tol: number): RankedPick[] {
  return cands
    .map(c => ({ ...c, ...rankOf(c, p, tol), area: boxArea(c.el) }))
    .sort((a, b) => a.rank - b.rank || a.area - b.area)
    .map(({ area: _a, ...r }) => r);
}

const key = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

/**
 * Walls joined end to end with `start` (Revit's Tab chain): follows each
 * shared endpoint; where several walls meet, only the one continuing
 * straight on, so a perimeter doesn't run into the partitions ending there.
 */
export function wallChain(start: CanonicalElement, elements: Iterable<CanonicalElement>): CanonicalElement[] {
  if (start.geometry !== 'line') return [start];
  const tables = start.tableName === 'structure_wall' ? new Set(['structure_wall']) : new Set(['wall', 'curtain_wall']);
  const walls: LineElement[] = [];
  for (const el of elements) if (tables.has(el.tableName) && el.geometry === 'line') walls.push(el);
  const at = new Map<string, LineElement[]>();
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      const k = key(p);
      const arr = at.get(k);
      if (arr) arr.push(w); else at.set(k, [w]);
    }
  }
  const dir = (w: LineElement, from: Point) => {
    const far = key(w.start) === key(from) ? w.end : w.start;
    const dx = far.x - from.x, dy = far.y - from.y, l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  const out = new Set<LineElement>([start as LineElement]);
  const queue: LineElement[] = [start as LineElement];
  while (queue.length) {
    const w = queue.shift()!;
    for (const node of [w.start, w.end]) {
      const others = (at.get(key(node)) ?? []).filter(o => o !== w);
      let next: LineElement[] = others;
      if (others.length > 1) {
        // Continue straight on (away from w's direction into the node)
        const inward = dir(w, node);
        next = others.filter(o => {
          const d = dir(o, node);
          return d.x * inward.x + d.y * inward.y < -0.99;
        }).slice(0, 1);
      }
      for (const o of next) if (!out.has(o)) { out.add(o); queue.push(o); }
    }
  }
  return [...out];
}
