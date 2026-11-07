import type { GridData } from '../types.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';

/**
 * Convert GridData[] (global state) to LineElement[] (document elements).
 * GridData uses model coordinates (Y-up), same as LineElement.
 */
export function gridsToElements(grids: GridData[]): LineElement[] {
  return grids.map(g => ({
    id: g.id,
    tableName: 'grid',
    discipline: 'reference',
    geometry: 'line' as const,
    start: { x: g.x1, y: g.y1 },
    end: { x: g.x2, y: g.y2 },
    strokeWidth: 0.06,
    attrs: (g.pinned ? { number: g.number, pinned: 'true' } : { number: g.number }) as Record<string, string>,
  }));
}

/**
 * Convert grid LineElements back to GridData[].
 */
export function elementsToGrids(elements: CanonicalElement[]): GridData[] {
  return elements
    .filter((e): e is LineElement => e.tableName === 'grid' && e.geometry === 'line')
    .map(el => ({
      id: el.id,
      number: el.attrs.number || el.id,
      x1: el.start.x,
      y1: el.start.y,
      x2: el.end.x,
      y2: el.end.y,
      ...(el.attrs.pinned === 'true' ? { pinned: true } : {}),
    }));
}
