/**
 * Edits that span levels: copy to levels, paste aligned to selected levels,
 * duplicate level, level elevation changes, group edits propagated to every
 * level. One undo step each.
 *
 * The open level lives in `state.document`, every other level in
 * `project.floors` (layers of GeoJSON + CSV rows). An edit is a per-level
 * element patch (id → element | null) plus, optionally, the new level list;
 * the history keeps the per-level before/after patches, so undoing after
 * other levels were edited in between only reverts what this edit touched.
 *
 * Level elevation rule: elements belong to their level. Everything a level
 * holds moves with it (base offsets, level-relative spatial Z in the editor);
 * only the absolute Z the spec stores in spatial GeoJSON (beams, ducts,
 * pipes, stairs, equipment, …) is rewritten. Editing an elevation can also
 * shift every higher level by the same amount (storey heights above kept).
 * Global (multi-storey) elements keep their absolute coordinates.
 */
import type { EditorState } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import type { FloorData, LayerData, Level } from '../types.ts';
import type { EditCommand } from '../model/history.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { groupByLayer, serializeToGeoJson } from '../model/serialize.ts';
import { addNumbers, cloneElements, expandCopySet, retargetLevelAttrs, RENUMBER_TABLES, type NumberPool } from '../model/copySet.ts';
import type { ProjectData } from '../types.ts';
import type { DocumentState } from '../model/document.ts';

export type ElementPatch = Map<string, CanonicalElement | null>;
export type LevelPatches = Map<string, ElementPatch>;

export interface MultiLevelEdit {
  floors: Map<string, { before: ElementPatch; after: ElementPatch }>;
  levels?: { before: Level[]; after: Level[] };
}

/** Files to rewrite on levels other than the open one: an append-only log
 *  (EditorShell persists the entries newer than the last one it handled). */
export interface FloorWrites {
  seq: number;
  writes: { seq: number; levelId: string; keys: string[] }[];
}

/** Tables whose GeoJSON carries absolute Z (rewritten when the level elevation changes). */
export const SPATIAL_Z_TABLES = new Set([
  'stair', 'stair_run', 'ramp', 'railing', 'beam', 'brace',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
]);

/** Elements of a level (the open level from the live document; grids excluded). */
export function levelElements(state: EditorState, levelId: string): Map<string, CanonicalElement> {
  const doc = state.document;
  if (doc && doc.levelId === levelId) {
    const m = new Map<string, CanonicalElement>();
    for (const el of doc.elements.values()) if (el.tableName !== 'grid') m.set(el.id, el);
    return m;
  }
  const floor = state.project?.floors.get(levelId);
  const m = new Map<string, CanonicalElement>();
  if (floor) for (const el of parseFloorLayers(floor.layers)) m.set(el.id, el);
  return m;
}

/** Room and door numbers in use across the project (the open level from the live document). */
export function projectNumbers(s: { project: ProjectData | null; document: DocumentState | null }): NumberPool {
  const pool: NumberPool = new Map();
  const open = s.document?.levelId;
  if (s.document) addNumbers(pool, [...s.document.elements.values()].map(e => ({ tableName: e.tableName, number: e.attrs.number })));
  for (const [levelId, floor] of s.project?.floors ?? []) {
    if (levelId === open) continue;
    for (const layer of floor.layers) {
      if (!RENUMBER_TABLES.has(layer.tableName)) continue;
      addNumbers(pool, [...layer.csvRows.values()].map(r => ({ tableName: layer.tableName, number: r.number })));
    }
  }
  return pool;
}

/** Ids a new element on `levelId` must not reuse (that level's and global/'s). */
export function takenIds(state: EditorState, levelId: string): Set<string> {
  const taken = new Set(levelElements(state, levelId).keys());
  for (const gl of state.project?.globalLayers ?? []) for (const id of gl.csvRows.keys()) taken.add(id);
  for (const g of state.grids) taken.add(g.id);
  return taken;
}

export function floorFromElements(levelId: string, levelName: string, elements: Iterable<CanonicalElement>): FloorData {
  const layers: LayerData[] = [];
  for (const [key, els] of groupByLayer([...elements].filter(e => e.tableName !== 'grid'))) {
    const [discipline, tableName] = key.split('/');
    layers.push({ tableName, discipline, geojsonContent: serializeToGeoJson(els), csvRows: new Map(els.map(e => [e.id, e.attrs])) });
  }
  return { levelId, levelName, layers };
}

const layerKey = (el: CanonicalElement) => `${el.discipline}/${el.tableName}`;

/** Layer keys of a level whose GeoJSON holds absolute Z. */
function spatialKeys(state: EditorState, levelId: string): string[] {
  const keys = new Set<string>();
  const doc = state.document;
  if (doc && doc.levelId === levelId) {
    for (const el of doc.elements.values()) if (SPATIAL_Z_TABLES.has(el.tableName)) keys.add(layerKey(el));
  } else {
    for (const l of state.project?.floors.get(levelId)?.layers ?? []) {
      if (SPATIAL_Z_TABLES.has(l.tableName)) keys.add(`${l.discipline}/${l.tableName}`);
    }
  }
  return [...keys];
}

/**
 * Put patches (and a level list) into the state. Returns the new state; the
 * open level's changes bump the document version (auto-save), other levels'
 * changed layers are queued in `floorWrites`.
 */
export function applyLevelPatches(state: EditorState, patches: LevelPatches, levels?: Level[]): EditorState {
  if (!state.project) return state;
  const project = { ...state.project, floors: new Map(state.project.floors) };
  const writes = new Map<string, Set<string>>();
  const addWrite = (levelId: string, keys: Iterable<string>) => {
    const s = writes.get(levelId) ?? new Set<string>();
    for (const k of keys) s.add(k);
    writes.set(levelId, s);
  };
  let next: EditorState = state;
  let docKeys: Set<string> | null = null;
  let document = state.document;

  const prevLevels = state.project.levels;
  const nextLevels = levels ? [...levels].sort((a, b) => a.elevation - b.elevation) : prevLevels;
  const exists = new Set(nextLevels.map(l => l.id));

  for (const [levelId, patch] of patches) {
    if (!exists.has(levelId) || patch.size === 0) continue;
    if (document && document.levelId === levelId) {
      const elements = new Map(document.elements);
      docKeys ??= new Set();
      for (const [id, el] of patch) {
        const old = elements.get(id);
        if (old) docKeys.add(layerKey(old));
        if (el) { elements.set(id, el); docKeys.add(layerKey(el)); } else elements.delete(id);
      }
      document = { ...document, elements };
      // The layer panel reads the level's layers: keep them in step
      const levelName = nextLevels.find(l => l.id === levelId)?.name || levelId;
      const floor = project.floors.get(levelId) ?? { levelId, levelName, layers: [] };
      const rebuilt = floorFromElements(levelId, levelName, elements.values());
      const keys = docKeys;
      project.floors.set(levelId, {
        ...floor,
        layers: [...floor.layers.filter(l => !keys.has(`${l.discipline}/${l.tableName}`)), ...rebuilt.layers.filter(l => keys.has(`${l.discipline}/${l.tableName}`))],
      });
      continue;
    }
    const levelName = nextLevels.find(l => l.id === levelId)?.name || levelId;
    const floor = project.floors.get(levelId) ?? { levelId, levelName, layers: [] };
    const elements = new Map<string, CanonicalElement>();
    for (const el of parseFloorLayers(floor.layers)) elements.set(el.id, el);
    const keys = new Set<string>();
    for (const [id, el] of patch) {
      const old = elements.get(id);
      if (old) keys.add(layerKey(old));
      if (el) { elements.set(id, el); keys.add(layerKey(el)); } else elements.delete(id);
    }
    // Layers this edit didn't touch keep their exact content.
    const rebuilt = floorFromElements(levelId, levelName, elements.values());
    const untouched = floor.layers.filter(l => !keys.has(`${l.discipline}/${l.tableName}`));
    const touched = rebuilt.layers.filter(l => keys.has(`${l.discipline}/${l.tableName}`));
    project.floors.set(levelId, { ...floor, levelName, layers: [...untouched, ...touched] });
    addWrite(levelId, keys);
  }

  // Elevation changes: absolute Z in spatial GeoJSON follows the level
  if (levels) {
    const before = new Map(prevLevels.map(l => [l.id, l.elevation]));
    for (const l of nextLevels) {
      const was = before.get(l.id);
      if (was === undefined || was === l.elevation) continue;
      const keys = spatialKeys({ ...state, document }, l.id);
      if (document && document.levelId === l.id) { docKeys ??= new Set(); keys.forEach(k => docKeys!.add(k)); }
      else if (keys.length) addWrite(l.id, keys);
    }
    for (const l of prevLevels) if (!exists.has(l.id)) project.floors.delete(l.id);
    project.levels = nextLevels;
    for (const l of nextLevels) {
      const f = project.floors.get(l.id);
      if (f && f.levelName !== l.name) project.floors.set(l.id, { ...f, levelName: l.name });
    }
  }

  next = { ...next, project, document };
  if (docKeys && document) {
    const version = state.documentVersion + 1;
    next = { ...next, documentVersion: version, lastMutation: { version, keys: [...docKeys] } };
  }
  if (writes.size > 0) {
    let seq = state.floorWrites?.seq ?? 0;
    const log = [...(state.floorWrites?.writes ?? []), ...[...writes].map(([levelId, keys]) => ({ seq: ++seq, levelId, keys: [...keys] }))];
    next = { ...next, floorWrites: { seq, writes: log.slice(-200) } };
  }
  return next;
}

/** Before-state of `patches`: the current element (or null) for every patched id. */
export function beforeOf(state: EditorState, patches: LevelPatches): LevelPatches {
  const out: LevelPatches = new Map();
  for (const [levelId, patch] of patches) {
    const current = levelElements(state, levelId);
    const b: ElementPatch = new Map();
    for (const id of patch.keys()) b.set(id, current.get(id) ?? null);
    out.set(levelId, b);
  }
  return out;
}

/** Build the history command of a multi-level edit. */
export function multiLevelCommand(description: string, before: LevelPatches, after: LevelPatches, levels?: { before: Level[]; after: Level[] }): EditCommand {
  const floors = new Map<string, { before: ElementPatch; after: ElementPatch }>();
  for (const [levelId, a] of after) floors.set(levelId, { before: before.get(levelId) ?? new Map(), after: a });
  return { description, before: new Map(), after: new Map(), multi: { floors, ...(levels ? { levels } : {}) } };
}

function patchesOf(cmd: EditCommand, side: 'before' | 'after'): LevelPatches {
  const out: LevelPatches = new Map();
  for (const [levelId, p] of cmd.multi!.floors) out.set(levelId, p[side]);
  return out;
}

/** The open level is gone after a level-list change: open another one. */
export function ensureOpenLevel(state: EditorState, openLevel: (s: EditorState, levelId: string) => EditorState): EditorState {
  const levels = state.project?.levels ?? [];
  if (!state.currentLevel || levels.some(l => l.id === state.currentLevel)) return state;
  const s: EditorState = { ...state, document: null, currentLevel: '' };
  return levels[0] ? openLevel(s, levels[0].id) : s;
}

export function undoMulti(state: EditorState, cmd: EditCommand, openLevel: (s: EditorState, id: string) => EditorState): EditorState {
  const m = cmd.multi!;
  // Restore elements first (on the levels that exist now), then the level list.
  let next = applyLevelPatches(state, patchesOf(cmd, 'before'));
  if (m.levels) next = applyLevelPatches(next, new Map(), m.levels.before);
  next = ensureOpenLevel(next, openLevel);
  return { ...next, history: { undoStack: state.history.undoStack.slice(0, -1), redoStack: [...state.history.redoStack, cmd] } };
}

export function redoMulti(state: EditorState, cmd: EditCommand, openLevel: (s: EditorState, id: string) => EditorState): EditorState {
  const m = cmd.multi!;
  let next = m.levels ? applyLevelPatches(state, new Map(), m.levels.after) : state;
  next = applyLevelPatches(next, patchesOf(cmd, 'after'));
  next = ensureOpenLevel(next, openLevel);
  return { ...next, history: { undoStack: [...state.history.undoStack, cmd], redoStack: state.history.redoStack.slice(0, -1) } };
}

// ─── Edit builders ───────────────────────────────────────────────────────────

/**
 * Copies of `ids` (raw ids on `fromLevel`, children included) placed on each
 * target level at the same plan position. Returns the per-level patches.
 */
/** Rooms and their boundaries: another discipline's copy must not cut the target level's rooms. */
const ROOM_TABLES = new Set(['space', 'room_separator']);

/**
 * The ids a Copy to Levels takes: rooms, room separators (and tags on them)
 * only when copied from the architecture (or all-disciplines) view.
 */
export function levelCopyIds(state: EditorState, ids: readonly string[]): string[] {
  const els = state.document?.elements;
  const d = state.activeDiscipline;
  if (!els || !d || d === 'architecture' || d === 'all') return [...ids];
  const isRoom = (id: string | undefined) => !!id && ROOM_TABLES.has(els.get(id)?.tableName ?? '');
  return ids.filter(id => {
    const el = els.get(id);
    return !isRoom(id) && !(el?.tableName === 'tag' && isRoom(el.attrs.host_id));
  });
}

export function copyToLevelsPatches(
  state: EditorState,
  source: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  fromLevel: string,
  targets: readonly string[],
  sourceLevels?: readonly Level[],
  numbers?: NumberPool,
): LevelPatches {
  const levels = state.project?.levels ?? [];
  const set = expandCopySet(source, ids);
  for (const id of [...set]) if (source.get(id)?.tableName === 'grid') set.delete(id);
  const out: LevelPatches = new Map();
  for (const to of targets) {
    const taken = takenIds(state, to);
    const { clones } = cloneElements(source, set, { taken, numbers });
    const patch: ElementPatch = new Map();
    for (const [id, el] of clones) {
      const attrs = retargetLevelAttrs(el.attrs, fromLevel, to, sourceLevels ?? levels);
      patch.set(id, attrs === el.attrs ? el : { ...el, attrs });
    }
    out.set(to, patch);
  }
  return out;
}

/** Everything on `levelId`, copied to the new level `target` (not yet in the project). */
export function duplicateLevelPatches(state: EditorState, levelId: string, target: Level): LevelPatches {
  const source = levelElements(state, levelId);
  const levels = [...(state.project?.levels ?? []), target];
  const taken = new Set<string>();
  for (const gl of state.project?.globalLayers ?? []) for (const id of gl.csvRows.keys()) taken.add(id);
  for (const g of state.grids) taken.add(g.id);
  const { clones } = cloneElements(source, source.keys(), { taken });
  const patch: ElementPatch = new Map();
  for (const [id, el] of clones) {
    const attrs = retargetLevelAttrs(el.attrs, levelId, target.id, levels);
    patch.set(id, attrs === el.attrs ? el : { ...el, attrs });
  }
  return new Map([[target.id, patch]]);
}
