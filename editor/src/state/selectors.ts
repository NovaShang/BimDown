import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData, CsvRow } from '../types.ts';
import { DISCIPLINE_TABLES, TABLE_TO_DISCIPLINE } from '../types.ts';
import { groupByLayer } from '../model/serialize.ts';
import { parseLayer } from '../model/parse.ts';
import { renderZIndexForTable } from '../model/tableRegistry.ts';
import { computeBounds } from '../model/elements.ts';

/** Check if a discipline should be visible given current discipline filter settings. */
export function isDisciplineVisible(discipline: string, state: EditorState): boolean {
  if (state.activeDiscipline === 'all') return true;
  if (discipline === state.activeDiscipline) return true;
  if (discipline === 'reference') return true;
  if (discipline === 'architecture' && state.showArchContext && state.activeDiscipline !== 'architecture') return true;
  return false;
}

/** A layer is "background" (dimmed + non-interactive) when its discipline is
 *  visible only as context — architecture under another active discipline, or
 *  reference (grids, levels) under any non-reference discipline. SVGLayers uses
 *  the same predicate to gate pointer events; selection paths that bypass DOM
 *  hit-testing (marquee) must re-apply it so users can't accidentally box-select
 *  grid lines under the architecture / structure / mep disciplines. */
export function isBackgroundDiscipline(discipline: string, activeDiscipline: string | null): boolean {
  if (!activeDiscipline || activeDiscipline === 'all') return false;
  if (discipline === 'architecture' && activeDiscipline !== 'architecture') return true;
  if (discipline === 'reference' && activeDiscipline !== 'reference') return true;
  return false;
}

export function getVisibleFloor(state: EditorState) {
  return state.project?.floors.get(state.currentLevel);
}

export function getLevelsWithData(state: EditorState) {
  if (!state.project) return [];
  return state.project.levels.filter(l => state.project!.floors.has(l.id));
}

function getRenderZIndex(tableName: string): number {
  return renderZIndexForTable(tableName);
}

export function getProcessedLayers(state: EditorState): ProcessedLayer[] {
  const floor = getVisibleFloor(state);
  if (!floor) return [];

  const orderedLayers = [...floor.layers].sort(
    (a, b) => getRenderZIndex(a.tableName) - getRenderZIndex(b.tableName)
  );

  const result = orderedLayers
    .filter(l => isDisciplineVisible(l.discipline, state) && state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
    .map(l => ({
      key: `${l.discipline}/${l.tableName}`,
      tableName: l.tableName,
      discipline: l.discipline,
      elements: parseLayer(l),
    }));

  appendGlobalLayers(state, result);
  return result;
}

export function getComputedViewBox(state: EditorState): { x: number; y: number; w: number; h: number } | null {
  // Compute from document elements when available (reflects edits)
  // Exclude grid lines — they're reference elements that shouldn't drive the view extent
  if (state.document) {
    const elements = Array.from(state.document.elements.values()).filter(e => e.tableName !== 'grid');
    const bounds = computeBounds(elements);
    if (bounds) return bounds;
  }

  // Fallback: compute from floor layer elements
  const floor = getVisibleFloor(state);
  if (floor) {
    const allElements = floor.layers.flatMap(l => parseLayer(l));
    const bounds = computeBounds(allElements);
    if (bounds) return bounds;
  }

  // Empty project fallback
  return state.currentLevel ? { x: -15, y: -15, w: 30, h: 30 } : null;
}

export function getLayerGroups(state: EditorState): LayerGroup[] {
  const allDisciplines = Object.keys(DISCIPLINE_TABLES);

  // Collect (layer, prefix) pairs. Prefix determines the selection-ID scope:
  //   - floor layers → currentLevel
  //   - global layers → "global"
  type Entry = { layer: LayerData; prefix: string };
  const byDiscipline = new Map<string, Entry[]>();
  const push = (layer: LayerData, prefix: string) => {
    if (!byDiscipline.has(layer.discipline)) byDiscipline.set(layer.discipline, []);
    byDiscipline.get(layer.discipline)!.push({ layer, prefix });
  };

  const floor = getVisibleFloor(state);
  if (floor) {
    for (const layer of floor.layers) push(layer, state.currentLevel);
  }

  // Grid layer from document elements (grids are scoped to the current level)
  if (state.document) {
    const gridEls = Array.from(state.document.elements.values()).filter(e => e.tableName === 'grid');
    if (gridEls.length > 0) {
      const gridCsvRows = new Map<string, Record<string, string>>();
      for (const el of gridEls) gridCsvRows.set(el.id, el.attrs);
      push({
        tableName: 'grid',
        discipline: 'reference',
        geojsonContent: '',
        csvRows: gridCsvRows,
      }, state.currentLevel);
    }
  }

  // Global layers (mesh, global railing, curtain_wall, etc.)
  if (state.project?.globalLayers) {
    for (const gl of state.project.globalLayers) {
      if (gl.tableName === 'level' || gl.tableName === 'grid') continue; // already handled
      push(gl, 'global');
    }
  }

  // Rebuild per discipline: merge by tableName, rekey csvRows with selection-ID prefix.
  // This dedupes floor + global entries for the same table and makes LeftPanel
  // selection IDs match the rest of the app (Canvas/3D use prefixed IDs).
  //
  // tablePrefix tracks which scope each tableName lives in so we can later
  // refresh csvRows from the live document with the correct selection-ID prefix.
  const tablePrefix = new Map<string, string>();
  const result = new Map<string, LayerData[]>();
  for (const [disc, entries] of byDiscipline) {
    const merged = new Map<string, LayerData>();
    for (const { layer, prefix } of entries) {
      tablePrefix.set(layer.tableName, prefix);
      const existing = merged.get(layer.tableName);
      const combined = new Map(existing?.csvRows ?? []);
      for (const [rawId, row] of layer.csvRows) {
        combined.set(`${prefix}:${rawId}`, row);
      }
      merged.set(layer.tableName, { ...(existing ?? layer), csvRows: combined });
    }
    result.set(disc, Array.from(merged.values()));
  }

  // Replace each layer's csvRows with the live document state so the panel
  // reflects CREATE / DELETE / UPDATE_ATTRS immediately rather than waiting
  // for a project reload. Falls through to the merged CSV-derived rows for
  // any table not present in the document (e.g. when project hasn't fully
  // hydrated yet).
  if (state.document) {
    const liveByTable = new Map<string, Map<string, Record<string, string>>>();
    for (const el of state.document.elements.values()) {
      let m = liveByTable.get(el.tableName);
      if (!m) { m = new Map(); liveByTable.set(el.tableName, m); }
      // The document only ever holds CURRENT-LEVEL elements, so their selection
      // ID is always currentLevel-scoped. Using tablePrefix here is wrong when a
      // table (e.g. wall) also has a global/ layer — its prefix gets overwritten
      // to "global", which would mislabel current-level walls as global:w-N.
      m.set(`${state.currentLevel}:${el.id}`, el.attrs);
    }
    const tablesInResult = new Set<string>();
    for (const [, layers] of result) {
      for (let i = 0; i < layers.length; i++) {
        tablesInResult.add(layers[i].tableName);
        const live = liveByTable.get(layers[i].tableName);
        if (live) layers[i] = { ...layers[i], csvRows: live };
      }
    }
    // Surface element types that exist ONLY in the live document — i.e. the
    // first element of a type the loaded project/floor never had. Without this
    // such a type would never appear in the Layers panel until a reload.
    for (const [tableName, csvRows] of liveByTable) {
      if (tablesInResult.has(tableName)) continue;
      const discipline = TABLE_TO_DISCIPLINE[tableName];
      if (!discipline) continue;
      if (!result.has(discipline)) result.set(discipline, []);
      result.get(discipline)!.push({ tableName, discipline, geojsonContent: '', csvRows });
    }
  }

  return allDisciplines.map(discipline => ({
    discipline,
    layers: result.get(discipline) ?? [],
  }));
}

export function getSelectedElementData(state: EditorState): Map<string, { tableName: string; discipline: string; csv: CsvRow }> {
  const result = new Map<string, { tableName: string; discipline: string; csv: CsvRow }>();
  if (state.selectedIds.size === 0) return result;

  // Source priority: document (live edits) → project (raw CSV) → visible floor.
  // The document is the canonical post-edit state; falling back to project's
  // CSV rows would surface stale data after UPDATE_ATTRS.
  for (const sid of state.selectedIds) {
    const colonIdx = sid.indexOf(':');
    const rawId = colonIdx >= 0 ? sid.slice(colonIdx + 1) : sid;
    const levelId = colonIdx >= 0 ? sid.slice(0, colonIdx) : null;

    if (state.document) {
      const el = state.document.elements.get(rawId);
      if (el) {
        result.set(sid, { tableName: el.tableName, discipline: el.discipline, csv: el.attrs });
        continue;
      }
    }

    if (state.project && levelId) {
      const layers = levelId === 'global'
        ? state.project.globalLayers
        : state.project.floors.get(levelId)?.layers;
      if (layers) {
        let found = false;
        for (const layer of layers) {
          const csv = layer.csvRows.get(rawId);
          if (csv) {
            result.set(sid, { tableName: layer.tableName, discipline: layer.discipline, csv });
            found = true;
            break;
          }
        }
        if (found) continue;
      }
    }

    const floor = getVisibleFloor(state);
    if (floor) {
      for (const layer of floor.layers) {
        const csv = layer.csvRows.get(rawId);
        if (csv) {
          result.set(sid, { tableName: layer.tableName, discipline: layer.discipline, csv });
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Get processed layers from the document model (for editing mode).
 * Serializes canonical elements → SVG → processor pipeline.
 */
export function getProcessedLayersFromDocument(state: EditorState): ProcessedLayer[] {
  if (!state.document) return getProcessedLayers(state);

  const elements = Array.from(state.document.elements.values());
  const groups = groupByLayer(elements);
  const result: ProcessedLayer[] = [];

  const sortedKeys = Array.from(groups.keys()).sort((keyA, keyB) => {
    const tableA = keyA.split('/')[1];
    const tableB = keyB.split('/')[1];
    return getRenderZIndex(tableA) - getRenderZIndex(tableB);
  });

  for (const key of sortedKeys) {
    const groupElements = groups.get(key)!;
    if (!state.visibleLayers.has(key)) continue;
    const [discipline, tableName] = key.split('/');
    if (!isDisciplineVisible(discipline, state)) continue;
    result.push({
      key,
      tableName,
      discipline,
      elements: groupElements,
    });
  }

  appendGlobalLayers(state, result);
  return result;
}

/**
 * Append globalLayers (cross-level elements stored in global/ directory) to the result.
 * Elements get "global:" ID prefix for consistency with 3D FloorGroup.
 * If a ProcessedLayer with the same `discipline/tableName` key already exists
 * (e.g. the current floor also has wall.csv), the global elements are merged
 * into that layer's `elements` array rather than appended as a duplicate entry
 * — duplicate entries would (a) produce repeated React keys in <SVGLayers /> and
 * (b) cause the same global element to be rendered in two <g> nodes.
 * Result is re-sorted by render z-index after merging.
 */
function appendGlobalLayers(state: EditorState, result: ProcessedLayer[]): void {
  const globalLayers = state.project?.globalLayers;
  if (!globalLayers || globalLayers.length === 0) return;

  const byKey = new Map<string, ProcessedLayer>();
  for (const layer of result) byKey.set(layer.key, layer);

  for (const gl of globalLayers) {
    const key = `${gl.discipline}/${gl.tableName}`;
    if (!state.visibleLayers.has(key)) continue;
    if (!isDisciplineVisible(gl.discipline, state)) continue;
    const elements = parseLayer(gl).map(el => ({ ...el, id: `global:${el.id}` }));
    if (elements.length === 0) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.elements = [...existing.elements, ...elements];
    } else {
      const layer: ProcessedLayer = { key, tableName: gl.tableName, discipline: gl.discipline, elements };
      result.push(layer);
      byKey.set(key, layer);
    }
  }

  result.sort((a, b) => getRenderZIndex(a.tableName) - getRenderZIndex(b.tableName));
}

export function getActiveDiscipline(state: EditorState): string | null {
  return state.activeDiscipline;
}
