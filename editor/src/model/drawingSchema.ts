import { defaultAttrsForTable, drawingFieldsForTable, TABLE_REGISTRY } from './tableRegistry.ts';
import type { Level } from '../types.ts';

// Re-export DrawingField from the registry
export type { DrawingField } from './tableRegistry.ts';

export function getDrawingFields(tableName: string, levels?: Level[]) {
  return drawingFieldsForTable(tableName, levels);
}

/**
 * Build the initial drawingAttrs for a table type.
 * Seeds from defaults filtered to drawing-relevant fields.
 * When levels are provided, computes smart top_level_id default:
 *   - next higher level → top_offset: 0
 *   - no higher level → current level, top_offset: 3
 */
export function getDefaultDrawingAttrs(
  tableName: string,
  currentLevelId?: string,
  levels?: Level[],
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const fields = getDrawingFields(tableName, levels);
  const defaults = defaultAttrsForTable(tableName, currentLevelId ?? '');
  for (const f of fields) {
    attrs[f.key] = defaults[f.key] ?? '';
  }

  // Smart top_level_id default
  const def = TABLE_REGISTRY[tableName];
  if (def?.hasVerticalSpan && levels && currentLevelId) {
    const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
    const currentIdx = sorted.findIndex(l => l.id === currentLevelId);
    if (currentIdx >= 0 && currentIdx < sorted.length - 1) {
      attrs.top_level_id = sorted[currentIdx + 1].id;
      attrs.top_offset = '0';
    } else {
      attrs.top_level_id = currentLevelId;
      attrs.top_offset = '3';
    }
  }

  return attrs;
}
