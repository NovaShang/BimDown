import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData, CsvRow } from '../types.ts';
import { DISCIPLINE_TABLES } from '../types.ts';
import { groupByLayer } from '../model/serialize.ts';
import { parseLayer } from '../model/parse.ts';
import { renderZIndexForTable } from '../model/tableRegistry.ts';
import { computeBounds } from '../model/elements.ts';

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
    .filter(l => (l.discipline === state.activeDiscipline || l.discipline === 'architecture' || l.discipline === 'reference') && state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
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

  const floor = getVisibleFloor(state);
  const byDiscipline = new Map<string, LayerData[]>();
  if (floor) {
    for (const layer of floor.layers) {
      if (!byDiscipline.has(layer.discipline)) byDiscipline.set(layer.discipline, []);
      byDiscipline.get(layer.discipline)!.push(layer);
    }
  }

  // Add grid layer from document elements (grids are global, not in floor.layers)
  if (state.document) {
    const gridEls = Array.from(state.document.elements.values()).filter(e => e.tableName === 'grid');
    if (gridEls.length > 0) {
      const gridCsvRows = new Map<string, Record<string, string>>();
      for (const el of gridEls) gridCsvRows.set(el.id, el.attrs);
      if (!byDiscipline.has('reference')) byDiscipline.set('reference', []);
      byDiscipline.get('reference')!.push({
        tableName: 'grid',
        discipline: 'reference',
        svgContent: '',
        csvRows: gridCsvRows,
      });
    }
  }

  return allDisciplines.map(discipline => ({
    discipline,
    layers: byDiscipline.get(discipline) ?? [],
  }));
}

export function getSelectedElementData(state: EditorState): Map<string, { tableName: string; discipline: string; csv: CsvRow }> {
  const result = new Map<string, { tableName: string; discipline: string; csv: CsvRow }>();
  if (state.selectedIds.size === 0) return result;

  // All Floors mode: IDs are prefixed as "levelId:elementId"
  // Handle prefixed IDs from 3D multi-floor mode (format: "levelId:elementId")
  if (state.project) {
    for (const prefixedId of state.selectedIds) {
      const colonIdx = prefixedId.indexOf(':');
      if (colonIdx === -1) continue;
      const levelId = prefixedId.slice(0, colonIdx);
      const rawId = prefixedId.slice(colonIdx + 1);
      // Check floor layers or global layers depending on prefix
      const layers = levelId === 'global'
        ? state.project.globalLayers
        : state.project.floors.get(levelId)?.layers;
      if (!layers) continue;
      for (const layer of layers) {
        const csv = layer.csvRows.get(rawId);
        if (csv) {
          result.set(prefixedId, { tableName: layer.tableName, discipline: layer.discipline, csv });
          break;
        }
      }
    }
    if (result.size > 0) return result;
  }

  // When document model exists, read from it (reflects edits)
  if (state.document) {
    for (const sid of state.selectedIds) {
      const rawId = sid.includes(':') ? sid.slice(sid.indexOf(':') + 1) : sid;
      const el = state.document.elements.get(rawId);
      if (el) {
        result.set(sid, { tableName: el.tableName, discipline: el.discipline, csv: el.attrs });
      }
    }
    return result;
  }

  const floor = getVisibleFloor(state);
  if (!floor) return result;

  for (const layer of floor.layers) {
    for (const sid of state.selectedIds) {
      const rawId = sid.includes(':') ? sid.slice(sid.indexOf(':') + 1) : sid;
      const csv = layer.csvRows.get(rawId);
      if (csv) {
        result.set(sid, { tableName: layer.tableName, discipline: layer.discipline, csv });
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
    if (discipline !== state.activeDiscipline && discipline !== 'architecture' && discipline !== 'reference') continue;
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
 * Result is re-sorted by render z-index after merging.
 */
function appendGlobalLayers(state: EditorState, result: ProcessedLayer[]): void {
  const globalLayers = state.project?.globalLayers;
  if (!globalLayers || globalLayers.length === 0) return;

  for (const gl of globalLayers) {
    const key = `${gl.discipline}/${gl.tableName}`;
    if (!state.visibleLayers.has(key)) continue;
    if (gl.discipline !== state.activeDiscipline && gl.discipline !== 'architecture' && gl.discipline !== 'reference') continue;
    const elements = parseLayer(gl).map(el => ({ ...el, id: `global:${el.id}` }));
    if (elements.length === 0) continue;
    result.push({ key, tableName: gl.tableName, discipline: gl.discipline, elements });
  }

  result.sort((a, b) => getRenderZIndex(a.tableName) - getRenderZIndex(b.tableName));
}

export function getActiveDiscipline(state: EditorState): string | null {
  return state.activeDiscipline;
}
