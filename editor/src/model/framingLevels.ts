/**
 * Framing across levels: the columns of lower levels (and global/) that hold
 * up a level's beams (their top is this level), and the beams on a column's
 * top level that follow when the column moves.
 */
import type { CanonicalElement, LineElement, PointElement } from './elements.ts';
import type { Level, ProjectData } from '../types.ts';
import { parseFloorLayers, parseLayer } from './parse.ts';
import { COLUMN_TABLES, columnFootprint, insideFootprint } from '../elements/_framing.ts';

const COLUMN_SET = new Set<string>(COLUMN_TABLES);
const FRAMING = new Set(['beam', 'brace']);
const TOL = 0.01;

function sortedLevels(project: ProjectData): Level[] {
  return [...project.levels].sort((a, b) => a.elevation - b.elevation);
}

/** Top level of a column based on `baseId`: top_level_id, else the level above. */
export function columnTopLevel(el: CanonicalElement, baseId: string, levels: readonly Level[]): string | undefined {
  if (el.attrs.top_level_id) return el.attrs.top_level_id;
  const i = levels.findIndex(l => l.id === baseId);
  return i >= 0 ? levels[i + 1]?.id : undefined;
}

const cache = new WeakMap<ProjectData, Map<string, PointElement[]>>();

/**
 * Columns from other levels and global/ whose top is `levelId` (or, for
 * multi-storey global columns, that run through it): what "beams between
 * columns" frames on a roof or any level without its own columns. The open
 * level's own columns are not included.
 */
export function columnsToppingAt(project: ProjectData, levelId: string): PointElement[] {
  let m = cache.get(project);
  if (!m) cache.set(project, m = new Map());
  const hit = m.get(levelId);
  if (hit) return hit;
  const levels = sortedLevels(project);
  const elev = levels.find(l => l.id === levelId)?.elevation;
  const out: PointElement[] = [];
  if (elev === undefined) return out;
  for (const lv of levels) {
    if (lv.id === levelId || lv.elevation >= elev) continue;
    const floor = project.floors.get(lv.id);
    if (!floor) continue;
    for (const el of parseFloorLayers(floor.layers.filter(l => COLUMN_SET.has(l.tableName)))) {
      if (el.geometry === 'point' && columnTopLevel(el, lv.id, levels) === levelId) out.push(el as PointElement);
    }
  }
  for (const layer of project.globalLayers) {
    if (!COLUMN_SET.has(layer.tableName)) continue;
    for (const el of parseLayer(layer)) {
      if (el.geometry !== 'point') continue;
      const base = levels.find(l => l.id === el.attrs.base_level_id);
      const top = levels.find(l => l.id === columnTopLevel(el, el.attrs.base_level_id ?? '', levels));
      if (base && top && base.elevation < elev - 1e-6 && top.elevation >= elev - 1e-6) out.push(el as PointElement);
    }
  }
  m.set(levelId, out);
  return out;
}

/**
 * Beams / braces on the top levels of moved columns (other than the open
 * level) whose ends frame into a moved column's head: they follow the move,
 * like same-level framing (framingCascade.ts). Returns level id → id → moved element.
 */
export function followColumnMovesAbove(
  project: ProjectData,
  openLevelId: string,
  before: ReadonlyMap<string, CanonicalElement>,
  movedIds: readonly string[],
  dx: number,
  dy: number,
): Map<string, Map<string, CanonicalElement | null>> {
  const levels = sortedLevels(project);
  const byTop = new Map<string, ReturnType<typeof columnFootprint>[]>();
  for (const id of movedIds) {
    const col = before.get(id);
    if (!col || !COLUMN_SET.has(col.tableName)) continue;
    const top = columnTopLevel(col, openLevelId, levels);
    const fp = columnFootprint(col);
    if (!top || top === openLevelId || !fp) continue;
    const list = byTop.get(top) ?? [];
    list.push(fp);
    byTop.set(top, list);
  }
  const out = new Map<string, Map<string, CanonicalElement | null>>();
  for (const [levelId, fps] of byTop) {
    const floor = project.floors.get(levelId);
    if (!floor) continue;
    const patch = new Map<string, CanonicalElement | null>();
    for (const el of parseFloorLayers(floor.layers.filter(l => FRAMING.has(l.tableName)))) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const ln = el as LineElement;
      const s = fps.some(fp => fp && insideFootprint(fp, ln.start, TOL));
      const e = fps.some(fp => fp && insideFootprint(fp, ln.end, TOL));
      if (!s && !e) continue;
      patch.set(el.id, {
        ...ln,
        start: s ? { x: ln.start.x + dx, y: ln.start.y + dy } : ln.start,
        end: e ? { x: ln.end.x + dx, y: ln.end.y + dy } : ln.end,
      });
    }
    if (patch.size > 0) out.set(levelId, patch);
  }
  return out;
}
