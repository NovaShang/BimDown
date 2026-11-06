import type { ProjectData } from '../types.ts';

/** Tables that make a floor worth opening on: walls and rooms. */
const PLAN_TABLES = new Set(['wall', 'curtain_wall', 'space']);

/**
 * The floor the editor opens on: the one nearest elevation 0 with walls or
 * rooms (then with any content), so a model whose lowest level is a
 * foundation opens on its ground floor. Ties go to the level at or above 0.
 * '' when no floor has content.
 */
export function pickStartLevel(project: ProjectData): string {
  const hasRows = (levelId: string, only?: Set<string>) =>
    project.floors.get(levelId)?.layers.some(l => l.csvRows.size > 0 && (!only || only.has(l.tableName))) ?? false;
  const nearestZero = (ids: string[]) => {
    const levels = project.levels.filter(l => ids.includes(l.id));
    levels.sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation) || b.elevation - a.elevation);
    return levels[0]?.id ?? '';
  };
  const ids = project.levels.map(l => l.id);
  return nearestZero(ids.filter(id => hasRows(id, PLAN_TABLES))) || nearestZero(ids.filter(id => hasRows(id)));
}
