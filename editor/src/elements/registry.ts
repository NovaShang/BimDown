import type { AnyElementModule, Archetype } from './archetypes.ts';
import type { GeometryType, PlacementType } from '../model/tableRegistry.ts';
import { resolvePropertyFields, type PropertyField } from './_propertyFields.ts';

// ─── Module registry ─────────────────────────────────────────────────────────

const registry = new Map<string, AnyElementModule>();

/**
 * Register an element module. Call from each elements/<table>.ts at module load.
 * Throws if the table name collides.
 *
 * If `module.propertyFields` is empty, it is auto-resolved from `csvHeaders`
 * and `drawingFields` via `resolvePropertyFields`. Modules can supply an
 * explicit non-empty list to override.
 */
export function registerElement(module: AnyElementModule): void {
  if (registry.has(module.table)) {
    throw new Error(`Element module already registered for table: ${module.table}`);
  }
  if (!module.propertyFields || module.propertyFields.length === 0) {
    (module as { propertyFields: PropertyField[] }).propertyFields =
      resolvePropertyFields(module.csvHeaders, module.drawingFields);
  }
  registry.set(module.table, module);
}

export function getElementModule(tableName: string): AnyElementModule | undefined {
  return registry.get(tableName);
}

export function hasElementModule(tableName: string): boolean {
  return registry.has(tableName);
}

export function allElementModules(): AnyElementModule[] {
  return Array.from(registry.values());
}

export function elementModulesByArchetype(archetype: Archetype): AnyElementModule[] {
  return allElementModules().filter(m => m.archetype === archetype);
}

export function elementModulesByDiscipline(discipline: string): AnyElementModule[] {
  return allElementModules().filter(m => m.discipline === discipline);
}

/** Tables for which the parser should skip GeoJSON. */
export function csvOnlyTables(): Set<string> {
  return new Set(allElementModules().filter(m => m.csvOnly).map(m => m.table));
}

/** Tables that allow both GeoJSON features and CSV-only rows. */
export function dualModeTables(): Set<string> {
  return new Set(allElementModules().filter(m => m.dualMode).map(m => m.table));
}

// ─── Archetype-derived metadata ──────────────────────────────────────────────

/**
 * Resolve the storage geometry type for an element module.
 * Returns the explicit `geometryType` field if set, otherwise derives from archetype.
 */
export function geometryTypeOf(mod: AnyElementModule): GeometryType {
  if (mod.geometryType) return mod.geometryType;
  switch (mod.archetype) {
    case 'line':
    case 'hosted':
      return 'line';
    case 'spatial-line':
    case 'topo-line':
      return 'spatial_line';
    case 'point':
      return 'point';
    case 'surface':
      return 'polygon';
  }
}

/**
 * Resolve the placement type for an element module.
 * Returns the explicit `placementType` field if set, otherwise derives from archetype.
 */
export function placementTypeOf(mod: AnyElementModule): PlacementType {
  if (mod.placementType) return mod.placementType;
  switch (mod.archetype) {
    case 'line':
      return 'free_line';
    case 'hosted':
      return 'hosted';
    case 'spatial-line':
    case 'topo-line':
      return 'spatial_line';
    case 'point':
      return 'free_point';
    case 'surface':
      return 'free_polygon';
  }
}
