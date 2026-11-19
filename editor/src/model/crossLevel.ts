/**
 * Cross-level lookup for geometry that depends on another level: a wall whose
 * top is attached to a roof on the roof level, a shaft opening that cuts the
 * slabs of every level it spans. Built from the project's floors (and the live
 * document for the level being edited); only the few tables such references
 * can target are parsed.
 */
import type { CanonicalElement } from './elements.ts';
import type { LayerData, ProjectData } from '../types.ts';
import { parseLayer } from './parse.ts';

export interface CrossLevelEntry {
  el: CanonicalElement;
  levelId: string;
  /** Elevation of the element's level. */
  elevation: number;
}

export interface CrossLevelIndex {
  /** Element by raw id (no level prefix), on any level; `preferLevel` wins ties. */
  find(rawId: string, preferLevel?: string): CrossLevelEntry | undefined;
  /** Vertical shaft openings (opening rows with a top_level_id), every level. */
  shafts: CrossLevelEntry[];
  /** Roofs and slabs a wall top can attach to, every level. */
  attachTargets: CrossLevelEntry[];
  /** Level elevation by id. */
  elevations: Map<string, number>;
}

/** Tables a cross-level reference can point at. */
export const CROSS_LEVEL_TABLES = new Set(['roof', 'slab', 'structure_slab', 'ceiling', 'opening']);

export const isShaft = (el: CanonicalElement) => el.tableName === 'opening' && el.geometry === 'polygon' && !!el.attrs.top_level_id;

const stripPrefix = (id: string) => {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
};

// Parsed layers are reused while the layer object is unchanged.
const layerCache = new WeakMap<LayerData, CanonicalElement[]>();
function parsed(layer: LayerData): CanonicalElement[] {
  let els = layerCache.get(layer);
  if (!els) {
    try { els = parseLayer(layer); } catch { els = []; }
    layerCache.set(layer, els);
  }
  return els;
}

export interface LiveLevel {
  levelId: string;
  elements: ReadonlyMap<string, CanonicalElement> | Iterable<CanonicalElement>;
}

const indexCache = new WeakMap<object, { sources: unknown[]; index: CrossLevelIndex }>();

/**
 * Build (or reuse) the index for a project, with the edited level taken from
 * `live`. The result keeps its identity while no roof / slab / ceiling /
 * opening changed, so geometry contexts depending on it don't rebuild on
 * every unrelated edit.
 */
export function crossLevelIndex(project: ProjectData | null | undefined, live?: LiveLevel | null): CrossLevelIndex | undefined {
  if (!project) return undefined;
  const sources: unknown[] = [project.levels];
  for (const [levelId, floor] of project.floors) {
    if (live && levelId === live.levelId) continue;
    for (const layer of floor.layers) if (CROSS_LEVEL_TABLES.has(layer.tableName)) sources.push(layer);
  }
  if (live) {
    sources.push(live.levelId);
    for (const el of liveElements(live)) if (CROSS_LEVEL_TABLES.has(el.tableName)) sources.push(el);
  }
  const hit = indexCache.get(project);
  if (hit && hit.sources.length === sources.length && hit.sources.every((s, i) => s === sources[i])) return hit.index;
  const index = buildCrossLevelIndex(project, live ?? undefined);
  indexCache.set(project, { sources, index });
  return index;
}

function liveElements(live: LiveLevel): Iterable<CanonicalElement> {
  const els = live.elements as ReadonlyMap<string, CanonicalElement>;
  return typeof els.values === 'function' && 'get' in els ? els.values() : live.elements as Iterable<CanonicalElement>;
}

export function buildCrossLevelIndex(project: ProjectData, live?: LiveLevel): CrossLevelIndex {
  const elevations = new Map(project.levels.map(l => [l.id, l.elevation]));
  const byId = new Map<string, CrossLevelEntry[]>();
  const shafts: CrossLevelEntry[] = [];
  const attachTargets: CrossLevelEntry[] = [];
  const add = (el: CanonicalElement, levelId: string) => {
    if (!CROSS_LEVEL_TABLES.has(el.tableName)) return;
    const entry = { el, levelId, elevation: elevations.get(levelId) ?? 0 };
    const raw = stripPrefix(el.id);
    let list = byId.get(raw);
    if (!list) byId.set(raw, list = []);
    list.push(entry);
    if (isShaft(el)) shafts.push(entry);
    if (el.tableName === 'roof' || el.tableName === 'slab' || el.tableName === 'structure_slab') attachTargets.push(entry);
  };
  for (const [levelId, floor] of project.floors) {
    if (live && levelId === live.levelId) continue;
    for (const layer of floor.layers) {
      if (!CROSS_LEVEL_TABLES.has(layer.tableName)) continue;
      for (const el of parsed(layer)) add(el, levelId);
    }
  }
  if (live) for (const el of liveElements(live)) add(el, live.levelId);
  return {
    find(rawId, preferLevel) {
      const list = byId.get(stripPrefix(rawId));
      if (!list || list.length === 0) return undefined;
      return (preferLevel && list.find(e => e.levelId === preferLevel)) || list[0];
    },
    shafts,
    attachTargets,
    elevations,
  };
}

/** Bottom and top elevation of a shaft opening (base level + base_offset → top level + top_offset). */
export function shaftRange(entry: CrossLevelEntry, elevations: Map<string, number>): [number, number] | null {
  const top = elevations.get(entry.el.attrs.top_level_id);
  if (top === undefined) return null;
  const z0 = entry.elevation + (parseFloat(entry.el.attrs.base_offset || '0') || 0);
  const z1 = top + (parseFloat(entry.el.attrs.top_offset || '0') || 0);
  return z1 > z0 ? [z0, z1] : null;
}
