import type { CanonicalElement } from './elements.ts';
import { TABLE_REGISTRY, prefixForTable, tableByPrefix } from './tableRegistry.ts';

/** Reverse lookup: prefix → tableName.
 *  Includes legacy prefixes for backward compatibility with existing data. */
export const REVERSE_PREFIX_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  // Current prefixes from registry
  for (const [name, def] of Object.entries(TABLE_REGISTRY)) {
    map[def.prefix] = name;
  }
  // Legacy prefixes (editor used to use these, existing data may still have them)
  map['wi'] = 'window';     // now 'wn'
  map['te'] = 'terminal';   // now 'tm'
  map['be'] = 'beam';       // now 'bm'
  map['ssl'] = 'structure_slab'; // now 'ss'
  return map;
})();

export function generateId(tableName: string, existingIds: Set<string>): string {
  const prefix = prefixForTable(tableName);
  let n = 1;
  while (existingIds.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
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
