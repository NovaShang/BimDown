import type { CanonicalElement } from './elements.ts';
import { TABLE_REGISTRY, prefixForTable } from './tableRegistry.ts';

/** Reverse lookup: prefix → tableName.
 *  Includes legacy prefixes for backward compatibility with existing data. */
export const REVERSE_PREFIX_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  // Current prefixes from registry
  for (const [name, def] of Object.entries(TABLE_REGISTRY)) {
    map[def.prefix] = name;
  }
  return map;
})();

export function generateId(tableName: string, existingIds: Set<string>): string {
  const prefix = prefixForTable(tableName);
  let n = 1;
  while (existingIds.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** Create a prefixed selection ID: "levelId:elementId" */
export function toSelectionId(levelId: string, elementId: string): string {
  return `${levelId}:${elementId}`;
}

/** Strip level prefix from a selection ID, returning the raw element ID.
 *  Works with both prefixed ("level-1:wall-1" → "wall-1") and raw ("wall-1" → "wall-1"). */
export function toElementId(selectionId: string): string {
  const i = selectionId.indexOf(':');
  return i >= 0 ? selectionId.slice(i + 1) : selectionId;
}

/** Extract level ID from a prefixed selection ID, or null if not prefixed. */
export function toLevelId(selectionId: string): string | null {
  const i = selectionId.indexOf(':');
  return i >= 0 ? selectionId.slice(0, i) : null;
}

export function findMaxIdCounters(elements: Map<string, CanonicalElement>): Map<string, number> {
  const counters = new Map<string, number>();
  for (const [id] of elements) {
    const match = id.match(/^([a-z]+)-(\d+)$/i);
    if (match) {
      const prefix = match[1];
      const num = parseInt(match[2], 10);
      counters.set(prefix, Math.max(counters.get(prefix) || 0, num));
    }
  }
  return counters;
}
