import type { AnyElementModule, Archetype } from './archetypes.ts';

// ─── Module registry ─────────────────────────────────────────────────────────

const registry = new Map<string, AnyElementModule>();

/**
 * Register an element module. Call from each elements/<table>.ts at module load.
 * Throws if the table name collides.
 */
export function registerElement(module: AnyElementModule): void {
  if (registry.has(module.table)) {
    throw new Error(`Element module already registered for table: ${module.table}`);
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
