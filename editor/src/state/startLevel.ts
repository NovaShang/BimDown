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

/** Tables that are context in any discipline (rooms traced on an MEP model, grids). */
const CONTEXT_TABLES = new Set(['space', 'room_separator', 'grid', 'level']);
const START_DISCIPLINES = new Set(['architecture', 'structure', 'mep']);

/**
 * The discipline the editor opens in: project_metadata.json `discipline`
 * (import-ifc writes it for MEP / structural models), else MEP or structure
 * when the model has no architectural elements besides rooms, else architecture.
 */
export function pickStartDiscipline(project: ProjectData): string {
  const hint = project.metadata.discipline;
  if (hint && START_DISCIPLINES.has(hint)) return hint;
  const n: Record<string, number> = {};
  const count = (layers: { tableName: string; discipline: string; csvRows: Map<string, unknown> }[]) => {
    for (const l of layers) if (!CONTEXT_TABLES.has(l.tableName)) n[l.discipline] = (n[l.discipline] ?? 0) + l.csvRows.size;
  };
  for (const floor of project.floors.values()) count(floor.layers);
  count(project.globalLayers);
  if (!(n.architecture > 0)) {
    if ((n.mep ?? 0) > 0 && (n.mep ?? 0) >= (n.structure ?? 0)) return 'mep';
    if ((n.structure ?? 0) > 0) return 'structure';
  }
  return 'architecture';
}
