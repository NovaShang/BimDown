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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;

  // Document mode: compute from elements (in scale(1,-1) coordinate space)
  if (state.document && state.document.elements.size > 0) {
    for (const el of state.document.elements.values()) {
      found = true;
      if (el.geometry === 'line') {
        for (const p of [el.start, el.end]) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
      } else if (el.geometry === 'point') {
        minX = Math.min(minX, el.position.x - el.width / 2);
        minY = Math.min(minY, el.position.y - el.height / 2);
        maxX = Math.max(maxX, el.position.x + el.width / 2);
        maxY = Math.max(maxY, el.position.y + el.height / 2);
      } else if (el.geometry === 'polygon') {
        for (const v of el.vertices) {
          minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
          maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
        }
      }
    }
  }

  // Read-only mode fallback: use first SVG layer viewBox (already in SVG coords)
  if (!found) {
    const floor = getVisibleFloor(state);
    if (floor) {
      for (const layer of floor.layers) {
        const vb = extractViewBox(layer.svgContent);
        if (vb) return { x: vb.x - vb.w * 0.15, y: vb.y - vb.h * 0.15, w: vb.w * 1.3, h: vb.h * 1.3 };
      }
    }
  }

  // Empty project fallback
  if (!found) {
    return state.currentLevel ? { x: -50, y: -50, w: 100, h: 100 } : null;
  }

  // Element coords use scale(1,-1), so SVG viewBox Y = -elementY
  const w = maxX - minX, h = maxY - minY;
  const pad = Math.max(w, h, 1) * 0.15;
  return { x: minX - pad, y: -maxY - pad, w: w + pad * 2, h: h + pad * 2 };
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
