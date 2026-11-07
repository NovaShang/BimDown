/**
 * What a copy takes along, and how copies get fresh ids.
 *
 * `expandCopySet` grows a selection by everything that depends on it:
 * hosted children (doors / windows / openings on a wall, stair runs and
 * landings, equipment ports), tags of copied elements, dimensions whose every
 * reference is copied, the passive MEP fittings between copied curves, and
 * the members of a copied model group.
 *
 * `cloneElements` gives every element a new id unique among `taken` and
 * rewrites the references between the copies (host_id, group_id, dimension
 * refs, MEP from/to, tag hosts). References to elements outside the copy
 * are dropped (a copied dimension becomes fixed, a copied pipe opens), except
 * `keepOutsideRefs` (same-level copies keep a door on the original wall).
 */
import type { CanonicalElement } from './elements.ts';
import type { Level } from '../types.ts';
import { generateId } from './ids.ts';
import { parseRef, formatRef } from '../annotation/geometry.ts';
import { parsePortRef, formatPortRef } from '../utils/portRef.ts';

const MEP_CURVES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

/** Host-like references of an element (ids it depends on). */
function dependsOn(el: CanonicalElement): string[] {
  const out: string[] = [];
  if (el.hostId) out.push(el.hostId);
  if (el.tableName === 'tag' && el.attrs.host_id) out.push(el.attrs.host_id);
  return out;
}

function dimensionRefs(el: CanonicalElement): string[] {
  return [el.attrs.start_ref, el.attrs.end_ref].map(r => parseRef(r).id).filter(Boolean);
}

export function groupMembers(elements: ReadonlyMap<string, CanonicalElement>, groupId: string): string[] {
  const out: string[] = [];
  for (const el of elements.values()) if (el.attrs.group_id === groupId && el.tableName !== 'model_group') out.push(el.id);
  return out;
}

/** Curves referencing `nodeId` through from / to: copied ones and all. */
function mepNodeTravels(elements: ReadonlyMap<string, CanonicalElement>, set: ReadonlySet<string>, nodeId: string): boolean {
  let copied = 0, all = 0;
  for (const c of elements.values()) {
    if (!MEP_CURVES.has(c.tableName)) continue;
    const n = (parsePortRef(c.attrs.from)?.hostId === nodeId ? 1 : 0) + (parsePortRef(c.attrs.to)?.hostId === nodeId ? 1 : 0);
    if (!n) continue;
    all += n;
    if (set.has(c.id)) copied += n;
  }
  return copied >= 2 || (copied >= 1 && copied === all);
}

/** Tables whose copies take the next free number (rooms, doors). */
export const RENUMBER_TABLES = new Set(['space', 'door']);

/** Numbers in use per table (RENUMBER_TABLES only). */
export type NumberPool = Map<string, Set<string>>;

export function addNumbers(pool: NumberPool, rows: Iterable<{ tableName: string; number?: string }>): NumberPool {
  for (const r of rows) {
    const n = (r.number ?? '').trim();
    if (!n || !RENUMBER_TABLES.has(r.tableName)) continue;
    let set = pool.get(r.tableName);
    if (!set) pool.set(r.tableName, set = new Set());
    set.add(n);
  }
  return pool;
}

/** The next number after `n` not in `used`: the last digit run counts up, keeping its width (D01 → D02, 101 → 102); without digits "-2", "-3"… */
export function nextFreeNumber(n: string, used: ReadonlySet<string>): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(n);
  for (let i = m ? parseInt(m[2], 10) + 1 : 2; ; i++) {
    const c = m ? `${m[1]}${String(i).padStart(m[2].length, '0')}${m[3]}` : `${n}-${i}`;
    if (!used.has(c)) return c;
  }
}

/** A–Z, AA, AB… (bijective base 26) ↔ 1, 2, 3… */
export function letterLabel(n: number): string {
  let s = '';
  for (let k = Math.max(1, Math.floor(n)); k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

export function letterIndex(label: string): number {
  let n = 0;
  for (const c of label.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

const LETTERS = /^[A-Za-z]+$/;

/** The next grid name after `name` not in `used`: B after A, AA after Z, 2 after 1, A2 after A1. */
export function nextGridName(name: string, used: ReadonlySet<string>): string {
  const n = name.trim();
  if (!LETTERS.test(n)) return nextFreeNumber(n || '0', used);
  const lower = n === n.toLowerCase();
  for (let i = letterIndex(n) + 1; ; i++) {
    const c = lower ? letterLabel(i).toLowerCase() : letterLabel(i);
    if (!used.has(c)) return c;
  }
}

/** Names of the grids among `elements`. */
export function gridNames(elements: Iterable<CanonicalElement>): Set<string> {
  const out = new Set<string>();
  for (const el of elements) if (el.tableName === 'grid' && el.attrs.number?.trim()) out.add(el.attrs.number.trim());
  return out;
}

/** The selection plus everything that has to travel with it (raw ids). */
export function expandCopySet(elements: ReadonlyMap<string, CanonicalElement>, ids: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const id of ids) if (elements.has(id) && elements.get(id)!.tableName !== 'connector') set.add(id);
  // Group rows bring their members
  for (const id of [...set]) {
    if (elements.get(id)!.tableName === 'model_group') for (const m of groupMembers(elements, id)) set.add(m);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of elements.values()) {
      // Section / elevation annotations belong to their view, not to the plan selection
      if (set.has(el.id) || el.attrs.view_id) continue;
      let take = false;
      if (el.tableName === 'dimension') {
        const refs = dimensionRefs(el);
        take = refs.length > 0 && refs.every(r => set.has(r));
      } else if (el.tableName === 'mep_node') {
        // A fitting or inline accessory (valve, damper…) joining copied curves,
        // or one whose every curve is copied (cap, end accessory)
        take = mepNodeTravels(elements, set, el.id);
      } else {
        const deps = dependsOn(el);
        take = deps.length > 0 && deps.some(d => set.has(d));
      }
      if (take) { set.add(el.id); grew = true; }
    }
  }
  return set;
}

export interface CloneOptions {
  /** Ids already used where the copies go (they are added to as copies are made). */
  taken: Set<string>;
  /** Keep references to elements outside the copy (copies on the same level). */
  keepOutsideRefs?: boolean;
  /** Ids to give particular copies (source id → id); the rest are generated. */
  preset?: ReadonlyMap<string, string>;
  /** Numbers in use: copied rooms and doors take the next free one (and add it). */
  numbers?: NumberPool;
  /** Grid names in use where the copies go (default: the grids of `elements`).
   *  Copied grids always take the next free name: two axes can't share one. */
  gridNames?: Set<string>;
}

/**
 * Clone `ids` of `elements` with new ids; returns the clones (same geometry)
 * and the old → new id map.
 */
export function cloneElements(
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  opts: CloneOptions,
): { clones: Map<string, CanonicalElement>; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const list: CanonicalElement[] = [];
  if (opts.preset) for (const v of opts.preset.values()) opts.taken.add(v);
  for (const id of ids) {
    const el = elements.get(id);
    if (!el) continue;
    const nid = opts.preset?.get(id) ?? generateId(el.tableName, opts.taken);
    opts.taken.add(nid);
    idMap.set(id, nid);
    list.push(el);
  }
  const keep = !!opts.keepOutsideRefs;
  let gridPool = opts.gridNames;
  const map = (id: string): string | null => idMap.get(id) ?? (keep && elements.has(id) ? id : null);
  const clones = new Map<string, CanonicalElement>();
  for (const el of list) {
    const nid = idMap.get(el.id)!;
    const attrs: Record<string, string> = { ...el.attrs, id: nid };
    let hostId = el.hostId;
    if (el.hostId) {
      const h = map(el.hostId);
      hostId = h ?? undefined;
      attrs.host_id = h ?? '';
    } else if (el.tableName === 'tag' && attrs.host_id) {
      attrs.host_id = map(attrs.host_id) ?? '';
    }
    if (attrs.group_id) attrs.group_id = idMap.get(attrs.group_id) ?? '';
    // A wall attached to a roof / floor: the copied one, else (same level) the same one, maybe on another level
    if (attrs.top_attach_id) attrs.top_attach_id = idMap.get(attrs.top_attach_id) ?? (keep ? attrs.top_attach_id : '');
    // Devices follow a copied circuit; otherwise same-level copies stay on theirs
    if (attrs.circuit_id) attrs.circuit_id = map(attrs.circuit_id) ?? '';
    if (opts.numbers && RENUMBER_TABLES.has(el.tableName) && attrs.number?.trim()) {
      let used = opts.numbers.get(el.tableName);
      if (!used) opts.numbers.set(el.tableName, used = new Set());
      attrs.number = nextFreeNumber(attrs.number.trim(), used);
      used.add(attrs.number);
    }
    if (el.tableName === 'grid') {
      gridPool ??= gridNames(elements.values());
      attrs.number = nextGridName(attrs.number ?? '', gridPool);
      gridPool.add(attrs.number);
    }
    if (el.tableName === 'dimension') {
      for (const side of ['start_ref', 'end_ref'] as const) {
        const { id, anchor } = parseRef(attrs[side]);
        if (!id) continue;
        const m = map(id);
        attrs[side] = m ? formatRef(m, anchor) : '';
      }
    }
    if (MEP_CURVES.has(el.tableName)) {
      for (const side of ['from', 'to'] as const) {
        const ref = parsePortRef(attrs[side]);
        if (!ref) continue;
        // A curve copied without the equipment it was connected to opens there.
        const m = idMap.get(ref.hostId);
        attrs[side] = m ? formatPortRef(m, ref.portName) : '';
      }
    }
    const clone = { ...el, id: nid, attrs } as CanonicalElement;
    if (hostId) clone.hostId = hostId; else delete clone.hostId;
    clones.set(nid, clone);
  }
  return { clones, idMap };
}

/**
 * Level references of an element copied from level `from` to level `to`:
 * the top constraint keeps the same number of storeys up (or falls back to
 * "the level above" when there is no such level).
 */
export function retargetLevelAttrs(attrs: Record<string, string>, from: string, to: string, levels: readonly Level[]): Record<string, string> {
  if (from === to) return attrs;
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  const fi = sorted.findIndex(l => l.id === from), ti = sorted.findIndex(l => l.id === to);
  const next = { ...attrs };
  if ('level_id' in next) next.level_id = to;
  if (next.base_level_id) next.base_level_id = to;
  if (next.top_level_id && fi >= 0 && ti >= 0) {
    const top = sorted.findIndex(l => l.id === next.top_level_id);
    const target = top >= 0 ? sorted[ti + (top - fi)] : undefined;
    next.top_level_id = target ? target.id : '';
  }
  return next;
}
