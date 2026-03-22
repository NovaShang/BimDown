import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData, CsvRow } from '../types.ts';
import { DISCIPLINE_TABLES } from '../types.ts';
import { processSvg, extractInnerSvg, extractViewBox } from '../utils/processor.ts';
import { groupByLayer } from '../model/serialize.ts';

export function getVisibleFloor(state: EditorState) {
  return state.project?.floors.get(state.currentLevel);
}

export function getLevelsWithData(state: EditorState) {
  if (!state.project) return [];
  return state.project.levels.filter(l => state.project!.floors.has(l.id));
}

const RENDER_Z_INDEX: Record<string, number> = {
  space: 10,
  slab: 20,
  structure_slab: 21,
  raft_foundation: 22,
  strip_foundation: 23,
  isolated_foundation: 24,
  stair: 30,
  wall: 40,
  structure_wall: 41,
  column: 50,
  structure_column: 51,
  window: 60,
  door: 61,
  beam: 70,
  brace: 71,
  duct: 80,
  pipe: 81,
  cable_tray: 82,
  conduit: 83,
  equipment: 90,
  terminal: 91,
};

function getRenderZIndex(tableName: string): number {
  return RENDER_Z_INDEX[tableName] ?? 100;
}

export function getProcessedLayers(state: EditorState): ProcessedLayer[] {
  const floor = getVisibleFloor(state);
  if (!floor) return [];

  const orderedLayers = [...floor.layers].sort(
    (a, b) => getRenderZIndex(a.tableName) - getRenderZIndex(b.tableName)
  );

  return orderedLayers
    .filter(l => (l.discipline === state.activeDiscipline || l.discipline === 'architechture') && state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
    .map(l => ({
      key: `${l.discipline}/${l.tableName}`,
      tableName: l.tableName,
      discipline: l.discipline,
      html: extractInnerSvg(processSvg(l.tableName, l.svgContent, l.csvRows)),
    }));
}

export function getComputedViewBox(state: EditorState): { x: number; y: number; w: number; h: number } | null {
  const floor = getVisibleFloor(state);
  if (!floor || floor.layers.length === 0) return null;

  for (const layer of floor.layers) {
    const vb = extractViewBox(layer.svgContent);
    if (vb) return vb;
  }
  return null;
}

export function getLayerGroups(state: EditorState): LayerGroup[] {
  const allDisciplines = Object.keys(DISCIPLINE_TABLES);

  if (state.currentLevel === '__all__' && state.project) {
    // Aggregate layers across all floors, deduplicating by discipline/tableName
    const byDiscipline = new Map<string, Map<string, LayerData>>();
    for (const floor of state.project.floors.values()) {
      for (const layer of floor.layers) {
        if (!byDiscipline.has(layer.discipline)) byDiscipline.set(layer.discipline, new Map());
        const existing = byDiscipline.get(layer.discipline)!.get(layer.tableName);
        if (existing) {
          const merged = new Map(existing.csvRows);
          for (const [k, v] of layer.csvRows) merged.set(k, v);
          byDiscipline.get(layer.discipline)!.set(layer.tableName, { ...existing, csvRows: merged });
        } else {
          byDiscipline.get(layer.discipline)!.set(layer.tableName, layer);
        }
      }
    }
    return allDisciplines.map(discipline => ({
      discipline,
      layers: Array.from(byDiscipline.get(discipline)?.values() ?? []),
    }));
  }

  const floor = getVisibleFloor(state);
  const byDiscipline = new Map<string, LayerData[]>();
  if (floor) {
    for (const layer of floor.layers) {
      if (!byDiscipline.has(layer.discipline)) byDiscipline.set(layer.discipline, []);
      byDiscipline.get(layer.discipline)!.push(layer);
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
  if (state.currentLevel === '__all__' && state.project) {
    for (const prefixedId of state.selectedIds) {
      const colonIdx = prefixedId.indexOf(':');
      if (colonIdx === -1) continue;
      const levelId = prefixedId.slice(0, colonIdx);
      const rawId = prefixedId.slice(colonIdx + 1);
      const floor = state.project.floors.get(levelId);
      if (!floor) continue;
      for (const layer of floor.layers) {
        const csv = layer.csvRows.get(rawId);
        if (csv) {
          result.set(prefixedId, { tableName: layer.tableName, discipline: layer.discipline, csv });
          break;
        }
      }
    }
    return result;
  }

  // When document model exists, read from it (reflects edits)
  if (state.document) {
    for (const id of state.selectedIds) {
      const el = state.document.elements.get(id);
      if (el) {
        result.set(id, { tableName: el.tableName, discipline: el.discipline, csv: el.attrs });
      }
    }
    return result;
  }

  const floor = getVisibleFloor(state);
  if (!floor) return result;

  for (const layer of floor.layers) {
    for (const id of state.selectedIds) {
      const csv = layer.csvRows.get(id);
      if (csv) {
        result.set(id, { tableName: layer.tableName, discipline: layer.discipline, csv });
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
    if (discipline !== state.activeDiscipline && discipline !== 'architechture') continue;
    result.push({
      key,
      tableName,
      discipline,
      html: '',  // not used when elements are present
      elements: groupElements,
    });
  }

  return result;
}

export function getActiveDiscipline(state: EditorState): string | null {
  return state.activeDiscipline;
}
