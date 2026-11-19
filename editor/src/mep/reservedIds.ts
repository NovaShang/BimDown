/**
 * Ids a new element must not take: every element id on the level, plus every
 * host a run's `from` / `to` names. Ids are per level, so a riser's ref to a
 * node on another level (`mn-19` on the roof) leaves a gap in this level's
 * numbering; a new fitting given that id would silently capture the riser.
 */
import type { CanonicalElement } from '../model/elements.ts';

const RUN_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

export function reservedIds(elements: ReadonlyMap<string, CanonicalElement> | null | undefined): Set<string> {
  const ids = new Set<string>(elements?.keys() ?? []);
  if (!elements) return ids;
  for (const el of elements.values()) {
    if (!RUN_TABLES.has(el.tableName)) continue;
    for (const ref of [el.attrs.from, el.attrs.to]) {
      const host = (ref ?? '').trim().split(':')[0];
      if (host) ids.add(host);
    }
  }
  return ids;
}
