import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData, CsvRow } from '../types.ts';
import { processSvg, extractInnerSvg, extractViewBox } from '../utils/processor.ts';
import { groupByLayer, serializeToSvg, elementsToCsvRows } from '../model/serialize.ts';

export function getVisibleFloor(state: EditorState) {
  return state.project?.floors.get(state.currentLevel);
}

export function getLevelsWithData(state: EditorState) {
  if (!state.project) return [];
  return state.project.levels.filter(l => state.project!.floors.has(l.id));
}

export function getProcessedLayers(state: EditorState): ProcessedLayer[] {
  const floor = getVisibleFloor(state);
  if (!floor) return [];

  return floor.layers
    .filter(l => state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
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
  const floor = getVisibleFloor(state);
  if (!floor) return [];

  const byDiscipline = new Map<string, LayerData[]>();
  for (const layer of floor.layers) {
    if (!byDiscipline.has(layer.discipline)) byDiscipline.set(layer.discipline, []);
    byDiscipline.get(layer.discipline)!.push(layer);
  }

  return Array.from(byDiscipline.entries()).map(([discipline, layers]) => ({
    discipline,
    layers,
  }));
}

export function getSelectedElementData(state: EditorState): Map<string, { tableName: string; discipline: string; csv: CsvRow }> {
  const result = new Map<string, { tableName: string; discipline: string; csv: CsvRow }>();
  if (state.selectedIds.size === 0) return result;

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

  const viewBox = getComputedViewBox(state);
  const vbStr = viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : '0 0 100 100';

  const elements = Array.from(state.document.elements.values());
  const groups = groupByLayer(elements);
  const result: ProcessedLayer[] = [];

  for (const [key, groupElements] of groups) {
    if (!state.visibleLayers.has(key)) continue;
    const [discipline, tableName] = key.split('/');
    const svgString = serializeToSvg(groupElements, vbStr);
    const csvRows = elementsToCsvRows(groupElements);
    const processed = processSvg(tableName, svgString, csvRows);
    result.push({
      key,
      tableName,
      discipline,
      html: extractInnerSvg(processed),
    });
  }

  return result;
}

export function getActiveDiscipline(state: EditorState): string | null {
  if (state.activeDiscipline) return state.activeDiscipline;

  // Auto-detect from selected element
  if (state.selectedIds.size > 0) {
    const data = getSelectedElementData(state);
    const first = data.values().next();
    if (!first.done) return first.value.discipline;
  }

  // Auto-detect from visible layers
  const floor = getVisibleFloor(state);
  if (!floor) return null;

  const disciplines = new Set(
    floor.layers
      .filter(l => state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
      .map(l => l.discipline)
  );

  if (disciplines.size === 1) return disciplines.values().next().value!;
  return null;
}
