/**
 * Host ids that MEP runs on other levels (and global/) reference. A riser
 * ends on a node of the level it reaches; seen from that level alone the
 * node has one run and looks orphaned, so the passive-node GC must keep it.
 */
import type { ProjectData } from '../types.ts';

const RUN_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);
const HOST_TABLES = new Set(['equipment', 'terminal', 'mep_node']);
const EMPTY: ReadonlySet<string> = new Set();
// Keyed on the floors map and the global layers (both replaced, not mutated, when they change).
const cache = new WeakMap<object, { global: unknown; byLevel: Map<string, ReadonlySet<string>> }>();

type Layers = readonly { tableName: string; csvRows: Map<string, Record<string, string>> }[];

/** Refs from `layers` to hosts those layers don't hold (ids are per level:
 *  a ref resolves on its own level first, so only these can reach another). */
export function crossLevelRefs(layers: Layers): string[] {
  const own = new Set<string>();
  for (const layer of layers) if (HOST_TABLES.has(layer.tableName)) for (const id of layer.csvRows.keys()) own.add(id);
  const out: string[] = [];
  for (const layer of layers) {
    if (!RUN_TABLES.has(layer.tableName)) continue;
    for (const row of layer.csvRows.values()) {
      for (const ref of [row.from, row.to]) {
        const r = (ref ?? '').trim();
        if (r && !own.has(r.split(':')[0])) out.push(r);
      }
    }
  }
  return out;
}

export function externalNodeRefs(project: ProjectData | null, currentLevel: string): ReadonlySet<string> {
  if (!project) return EMPTY;
  let entry = cache.get(project.floors);
  if (!entry || entry.global !== project.globalLayers) cache.set(project.floors, entry = { global: project.globalLayers, byLevel: new Map() });
  const hit = entry.byLevel.get(currentLevel);
  if (hit) return hit;
  const out = new Set<string>();
  const add = (layers: Layers) => { for (const r of crossLevelRefs(layers)) out.add(r.split(':')[0]); };
  for (const [levelId, floor] of project.floors) if (levelId !== currentLevel) add(floor.layers);
  add(project.globalLayers);
  entry.byLevel.set(currentLevel, out);
  return out;
}
