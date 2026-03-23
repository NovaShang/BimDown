import type { CanonicalElement } from './elements.ts';

const PREFIX_MAP: Record<string, string> = {
  wall: 'w', curtain_wall: 'cw', structure_wall: 'sw', column: 'c', structure_column: 'sc',
  door: 'd', window: 'wi', space: 'sp', slab: 'sl', structure_slab: 'ssl',
  stair: 'st', duct: 'du', pipe: 'pi', equipment: 'eq', terminal: 'te',
  conduit: 'co', cable_tray: 'ct', beam: 'be', brace: 'br',
  grid: 'gr',
};

/** Reverse lookup: prefix → tableName */
export const REVERSE_PREFIX_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(PREFIX_MAP).map(([table, prefix]) => [prefix, table])
);

export function generateId(tableName: string, existingIds: Set<string>): string {
  const prefix = PREFIX_MAP[tableName] || 'x';
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
