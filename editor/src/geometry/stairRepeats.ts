/**
 * Multi-storey stairs seen from the storeys they repeat on: the stair of a
 * lower level (multistory_top_level_id) with its runs, landings and stair
 * railings, for the 2D plan and plan sheets of an upper level.
 */
import type { CanonicalElement } from '../model/elements.ts';
import type { Level, ProjectData } from '../types.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { hostRefOf, stairRepetitions } from './stair.ts';

const STAIR_PARTS = new Set(['stair_run', 'stair_landing', 'railing']);

export interface RepeatedStairs {
  /** The stairs' own level. */
  level: Level;
  /** Stairs repeating on the asked level, their parts and stair railings (ids as on their level). */
  elements: CanonicalElement[];
}

export function stairsRepeatingOn(project: ProjectData | null | undefined, levelId: string): RepeatedStairs[] {
  if (!project) return [];
  const elevations = new Map(project.levels.map(l => [l.id, l.elevation]));
  const out: RepeatedStairs[] = [];
  for (const [srcId, floor] of project.floors) {
    if (srcId === levelId) continue;
    const level = project.levels.find(l => l.id === srcId);
    const stairLayer = floor.layers.find(l => l.tableName === 'stair');
    if (!level || !stairLayer || ![...stairLayer.csvRows.values()].some(r => r.multistory_top_level_id)) continue;
    const elements = parseFloorLayers(floor.layers.filter(l => l.tableName === 'stair' || STAIR_PARTS.has(l.tableName)));
    const stairs = elements.filter(el => el.tableName === 'stair'
      && stairRepetitions(el.attrs, srcId, level.elevation, elevations).some(r => r.index > 0 && r.levelId === levelId));
    if (stairs.length === 0) continue;
    const ids = new Set(stairs.map(s => s.id));
    out.push({ level, elements: [...stairs, ...elements.filter(el => STAIR_PARTS.has(el.tableName) && ids.has(hostRefOf(el)))] });
  }
  return out;
}
