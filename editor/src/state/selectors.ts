import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData, CsvRow } from '../types.ts';
import { processSvg, extractInnerSvg, extractViewBox } from '../utils/processor.ts';

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
