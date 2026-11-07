import { defaultAttrsForTable, drawingFieldsForTable, isVerticalSpanTable } from './tableRegistry.ts';
import { getElementModule } from '../elements/registry.ts';
import type { Level } from '../types.ts';

// Re-export DrawingField from the registry
export type { DrawingField } from './tableRegistry.ts';

export function getDrawingFields(tableName: string, levels?: Level[], variantId?: string) {
  const fields = drawingFieldsForTable(tableName, levels);
  const variant = variantId
    ? getElementModule(tableName)?.toolbarVariants?.find(v => v.id === variantId)
    : undefined;
  if (!variant) return fields;
  const keep = variant.fields;
  const labels = variant.fieldLabels ?? {};
  return [...(variant.extraFields ?? []), ...fields]
    .filter(f => !keep || keep.includes(f.key) || f.key.startsWith('__'))
    .map(f => labels[f.key] ? { ...f, label: labels[f.key] } : f);
}

/**
 * Build the initial drawingAttrs for a table type.
 * Seeds from defaults filtered to drawing-relevant fields.
 * When levels are provided, computes smart top_level_id default:
 *   - next higher level → top_offset: 0
 *   - no higher level → current level, top_offset: 3
 * A toolbar variant's defaults and the module's level-height defaults
 * (e.g. a brace spanning the storey) are merged over the table defaults.
 */
export function getDefaultDrawingAttrs(
  tableName: string,
  currentLevelId?: string,
  levels?: Level[],
  variantId?: string,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const fields = getDrawingFields(tableName, levels, variantId);
  const mod = getElementModule(tableName);
  const variant = variantId ? mod?.toolbarVariants?.find(v => v.id === variantId) : undefined;
  const defaults: Record<string, string> = {
    ...defaultAttrsForTable(tableName, currentLevelId ?? ''),
    ...(mod?.levelHeightDefaults ? mod.levelHeightDefaults(levelHeight(currentLevelId, levels)) : {}),
    ...(variant?.defaults ?? {}),
  };
  for (const f of fields) {
    attrs[f.key] = defaults[f.key] ?? '';
  }
  // Variant-only attrs (e.g. foundation `kind`) ride along even without a field.
  for (const [k, v] of Object.entries(variant?.defaults ?? {})) {
    if (!(k in attrs)) attrs[k] = v;
  }

  // Smart top_level_id default
  if (isVerticalSpanTable(tableName) && levels && currentLevelId) {
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

/** Storey height at a level: next level's elevation − this one's; 3 m on the
 *  top level or when levels are unknown. */
export function levelHeight(currentLevelId?: string, levels?: Level[]): number {
  if (!levels || !currentLevelId) return 3;
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  const i = sorted.findIndex(l => l.id === currentLevelId);
  if (i < 0 || i + 1 >= sorted.length) return 3;
  const h = sorted[i + 1].elevation - sorted[i].elevation;
  return h > 0 ? h : 3;
}
