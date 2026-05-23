export interface Level {
  id: string;
  number: string;
  name: string;
  elevation: number;
}

export interface CsvRow {
  [key: string]: string;
}

export interface LayerData {
  tableName: string;
  discipline: string;
  /** Raw GeoJSON FeatureCollection string for the layer (empty if CSV-only table). */
  geojsonContent: string;
  csvRows: Map<string, CsvRow>;
}

export interface FloorData {
  levelId: string;
  levelName: string;
  layers: LayerData[];
}

export interface ProjectMetadata {
  format_version: string;
  project_name?: string;
  units?: string;
  source?: string;
}

/** One row of the project-level `global/mep_system.csv` lookup table. Lets users
 *  override the editor's curated MEP system color and give each system a
 *  human-readable name. See `_mepLineShared.tsx::resolveSystemColor` for how
 *  these are consulted at draw time. */
export interface SystemDef {
  id: string;
  system_type: string;
  name: string;
  /** Hex color (e.g. `#06b6d4`). Empty string → editor falls back to its
   *  curated SYSTEM_COLORS / hash color for `system_type`. */
  color: string;
  /** One of `hvac` / `plumbing` / `electrical` / `other`. */
  discipline: string;
}

export interface ProjectData {
  levels: Level[];
  floors: Map<string, FloorData>;
  /** Element layers from global/ directory (multi-story elements spanning >1 level) */
  globalLayers: LayerData[];
  /** Project-level MEP system definitions from `global/mep_system.csv`.
   *  Empty array when the file is absent — auto-coloring stays in effect. */
  mepSystems: SystemDef[];
  metadata: ProjectMetadata;
}

export interface GridData {
  id: string;
  number: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type SvgElementType = 'line' | 'rect' | 'polygon' | 'circle' | 'path';

// Re-export LayerStyle type and data from the centralized registry
export type { LayerStyle } from './model/tableRegistry.ts';
export {
  DISCIPLINE_COLORS,
  DISCIPLINES,
  tablesForDiscipline,
  disciplineForTable,
  layerStyleForTable,
  allTableNames,
} from './model/tableRegistry.ts';

// Backward-compatible aliases derived from the element-module registry.
//
// These objects are proxies that query the registry on every read so they
// work correctly even when consumed during module-init (before all element
// modules have self-registered). Avoid using them in hot paths; prefer
// calling the helper functions directly.
import {
  getElementModule,
  hasElementModule,
  allElementModules,
} from './elements/registry.ts';
import type { LayerStyle } from './model/tableRegistry.ts';

const KNOWN_DISCIPLINES = ['architecture', 'structure', 'mep', 'reference'] as const;

function lazyTableRecord<V>(value: (mod: import('./elements/archetypes.ts').AnyElementModule) => V): Record<string, V> {
  return new Proxy({} as Record<string, V>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      const mod = getElementModule(prop);
      return mod ? value(mod) : undefined;
    },
    has(_, prop) {
      return typeof prop === 'string' && hasElementModule(prop);
    },
    ownKeys() {
      return allElementModules().map(m => m.table);
    },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop !== 'string') return undefined;
      const mod = getElementModule(prop);
      return mod
        ? { value: value(mod), writable: false, enumerable: true, configurable: true }
        : undefined;
    },
  });
}

export const LAYER_STYLES: Record<string, LayerStyle> = lazyTableRecord(m => m.layerStyle);

export const DISCIPLINE_TABLES: Record<string, string[]> = new Proxy({} as Record<string, string[]>, {
  get(_, prop) {
    if (typeof prop !== 'string') return undefined;
    return allElementModules().filter(m => m.discipline === prop).map(m => m.table);
  },
  has(_, prop) {
    return typeof prop === 'string' && (KNOWN_DISCIPLINES as readonly string[]).includes(prop);
  },
  ownKeys() {
    return [...KNOWN_DISCIPLINES];
  },
  getOwnPropertyDescriptor(_, prop) {
    if (typeof prop !== 'string') return undefined;
    if (!(KNOWN_DISCIPLINES as readonly string[]).includes(prop)) return undefined;
    return {
      value: allElementModules().filter(m => m.discipline === prop).map(m => m.table),
      writable: false, enumerable: true, configurable: true,
    };
  },
});

export const TABLE_TO_DISCIPLINE: Record<string, string> = lazyTableRecord(m => m.discipline);

/**
 * Lazy array of all registered table names. Backed by a Proxy that delegates
 * read operations to the live registry, so calls like `.map`, `.filter`,
 * `.includes`, `.length`, and `for…of` iteration always reflect the current
 * set of registered modules.
 */
export const ALL_TABLE_NAMES: string[] = new Proxy([] as string[], {
  get(_, prop) {
    const names = allElementModules().map(m => m.table);
    const value = (names as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as Function).bind(names) : value;
  },
  has(_, prop) {
    return prop in allElementModules().map(m => m.table);
  },
  ownKeys() {
    const names = allElementModules().map(m => m.table);
    return [...Object.keys(names), 'length'];
  },
  getOwnPropertyDescriptor(_, prop) {
    const names = allElementModules().map(m => m.table);
    if (prop === 'length') {
      return { value: names.length, writable: false, enumerable: false, configurable: false };
    }
    const idx = typeof prop === 'string' ? Number(prop) : NaN;
    if (Number.isInteger(idx) && idx >= 0 && idx < names.length) {
      return { value: names[idx], writable: false, enumerable: true, configurable: true };
    }
    return undefined;
  },
});
