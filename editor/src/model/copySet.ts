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
      if (set.has(el.id)) continue;
      let take = false;
      if (el.tableName === 'dimension') {
        const refs = dimensionRefs(el);
        take = refs.length > 0 && refs.every(r => set.has(r));
      } else if (el.tableName === 'mep_node') {
        // A passive fitting joining copied curves
        let n = 0;
        for (const id of set) {
          const c = elements.get(id)!;
          if (!MEP_CURVES.has(c.tableName)) continue;
          if (parsePortRef(c.attrs.from)?.hostId === el.id || parsePortRef(c.attrs.to)?.hostId === el.id) n++;
        }
        take = n >= 2 && !(el.attrs.kind ?? '').trim();
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
