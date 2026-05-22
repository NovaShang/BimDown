/**
 * tableRegistry — derived shim over the element-module registry.
 *
 * Historical name. The hardcoded TABLE_REGISTRY object has been retired;
 * all per-element metadata lives in `editor/src/elements/<table>.tsx`
 * modules and is queried via `elements/registry.ts`. This file now only
 * exposes:
 *   - type aliases (GeometryType, PlacementType, DrawingField, LayerStyle)
 *   - helper functions that delegate to the element registry
 *   - DISCIPLINE_COLORS / DISCIPLINES constants
 *
 * All helper functions are lazy — they query the element registry at call
 * time, so they are safe to use during module init even before all
 * element modules have self-registered.
 */
import type { Level } from '../types.ts';
import {
  getElementModule,
  allElementModules,
  geometryTypeOf,
  placementTypeOf,
} from '../elements/registry.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type GeometryType = 'line' | 'spatial_line' | 'point' | 'polygon' | 'mixed';
export type PlacementType = 'free_line' | 'spatial_line' | 'hosted' | 'free_point' | 'free_polygon' | 'grid';

export interface DrawingField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select';
  unit?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface LayerStyle {
  displayName: string;
  color: string;
  icon: string;
  order: number;
}

// ─── Helper functions (derived from element registry) ────────────────────────

export function geometryTypeForTable(name: string): GeometryType | null {
  const mod = getElementModule(name);
  return mod ? geometryTypeOf(mod) : null;
}

export function placementTypeForTable(name: string): PlacementType {
  const mod = getElementModule(name);
  if (!mod) return 'free_line';
  return placementTypeOf(mod);
}

export function prefixForTable(name: string): string {
  return getElementModule(name)?.prefix ?? 'x';
}

export function tableByPrefix(prefix: string): string | null {
  for (const mod of allElementModules()) {
    if (mod.prefix === prefix) return mod.table;
  }
  return null;
}

export function csvHeadersForTable(name: string): string[] {
  return getElementModule(name)?.csvHeaders ?? ['number', 'base_offset'];
}

export function defaultAttrsForTable(name: string, levelId: string): Record<string, string> {
  const mod = getElementModule(name);
  if (!mod) return { base_offset: '0' };
  const attrs = { ...mod.defaults };
  if (mod.hasVerticalSpan && attrs.top_level_id === '') {
    attrs.top_level_id = levelId;
  }
  return attrs;
}

export function isVerticalSpanTable(name: string): boolean {
  return !!getElementModule(name)?.hasVerticalSpan;
}

export function drawingFieldsForTable(name: string, levels?: Level[]): DrawingField[] {
  const mod = getElementModule(name);
  if (!mod) return [];

  const topFields: DrawingField[] = mod.hasVerticalSpan && levels
    ? [
        { key: 'top_level_id', label: 'Top', type: 'select', options: levels.map(l => ({ value: l.id, label: l.name || l.id })) },
        { key: 'top_offset', label: 'Top Offset', type: 'number', unit: 'm', step: 0.1 },
      ]
    : [];

  return [...mod.drawingFields, ...topFields];
}

export function isHostedTable(name: string): boolean {
  return !!getElementModule(name)?.hostType;
}

export function hostTablesFor(name: string): Set<string> {
  return new Set(getElementModule(name)?.hostTables ?? []);
}

export function widthAttrFor(name: string): string {
  return getElementModule(name)?.widthAttr ?? 'width';
}

export function renderZIndexForTable(name: string): number {
  return getElementModule(name)?.renderZIndex ?? 100;
}

export function layerStyleForTable(name: string): LayerStyle {
  return getElementModule(name)?.layerStyle ?? { displayName: name, color: '#888', icon: '?', order: 99 };
}

export function disciplineForTable(name: string): string {
  return getElementModule(name)?.discipline ?? '';
}

export function tablesForDiscipline(discipline: string): string[] {
  return allElementModules().filter(m => m.discipline === discipline).map(m => m.table);
}

export function allTableNames(): string[] {
  return allElementModules().map(m => m.table);
}

// ─── Discipline metadata ─────────────────────────────────────────────────────

export const DISCIPLINE_COLORS: Record<string, string> = {
  architecture: '#3a86ff',
  structure:     '#e07a2f',
  mep:           '#00b4d8',
  reference:     '#ef476f',
};

export const DISCIPLINES = ['all', ...Object.keys(DISCIPLINE_COLORS)];
