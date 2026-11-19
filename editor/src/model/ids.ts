import type { CanonicalElement } from './elements.ts';
import { prefixForTable } from './tableRegistry.ts';
import { allElementModules } from '../elements/registry.ts';

/** Reverse lookup: prefix → tableName.
 *
 * Lazy Proxy: queries the element module registry on every read, so it
 * works correctly even when accessed before all element modules have
 * self-registered at module-load time.
 */
export const REVERSE_PREFIX_MAP: Record<string, string> = new Proxy({}, {
  get(_, prop) {
    if (typeof prop !== 'string') return undefined;
    for (const mod of allElementModules()) {
      if (mod.prefix === prop) return mod.table;
    }
    return undefined;
  },
  has(_, prop) {
    if (typeof prop !== 'string') return false;
    for (const mod of allElementModules()) {
      if (mod.prefix === prop) return true;
    }
    return false;
  },
  ownKeys() {
    return allElementModules().map(m => m.prefix);
  },
  getOwnPropertyDescriptor(_, prop) {
    if (typeof prop !== 'string') return undefined;
    for (const mod of allElementModules()) {
      if (mod.prefix === prop) {
        return { value: mod.table, writable: false, enumerable: true, configurable: true };
      }
    }
    return undefined;
  },
}) as Record<string, string>;

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
