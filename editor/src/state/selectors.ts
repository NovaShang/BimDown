import type { EditorState, ProcessedLayer, LayerGroup } from './editorTypes.ts';
import type { LayerData } from '../types.ts';
import { DISCIPLINE_TABLES } from '../types.ts';
import { extractViewBox } from '../utils/processor.ts';
import { groupByLayer } from '../model/serialize.ts';
import { parseLayer } from '../model/parse.ts';

export function getVisibleFloor(state: EditorState) {
  return state.project?.floors.get(state.currentLevel);
}

export function getLevelsWithData(state: EditorState) {
  if (!state.project) return [];
  return state.project.levels.filter(l => state.project!.floors.has(l.id));
}

const RENDER_Z_INDEX: Record<string, number> = {
  grid: 1,
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
    .filter(l => (l.discipline === state.activeDiscipline || l.discipline === 'architechture' || l.discipline === 'reference') && state.visibleLayers.has(`${l.discipline}/${l.tableName}`))
    .map(l => ({
      key: `${l.discipline}/${l.tableName}`,
      tableName: l.tableName,
      discipline: l.discipline,
      elements: parseLayer(l),
    }));
}

export function getComputedViewBox(state: EditorState): { x: number; y: number; w: number; h: number } | null {
  // Use first SVG layer viewBox (stable, matches original data)
  const floor = getVisibleFloor(state);
  if (floor) {
    for (const layer of floor.layers) {
      const vb = extractViewBox(layer.svgContent);
      if (vb) return vb;
    }
  }

  // Empty project fallback
  return state.currentLevel ? { x: -50, y: -50, w: 100, h: 100 } : null;
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
    if (result.size > 0) return result;
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
    if (discipline !== state.activeDiscipline && discipline !== 'architechture' && discipline !== 'reference') continue;
    result.push({
      key,
      tableName,
      discipline,
      elements: groupElements,
    });
  }

  return result;
}

export function getActiveDiscipline(state: EditorState): string | null {
  return state.activeDiscipline;
}
