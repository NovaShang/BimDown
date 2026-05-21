import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ResolvedTable, ResolvedField } from './types.js';
import { loadAllSchemas, resolveFields } from './loader.js';

export const ID_PREFIXES: Record<string, string> = {
  level: 'lv', grid: 'gr', wall: 'w', column: 'c', slab: 'sl',
  space: 'sp', door: 'd', window: 'wn', stair: 'st',
  ramp: 'rp', railing: 'rl', room_separator: 'rs',
  curtain_wall: 'cw', roof: 'ro', ceiling: 'cl', opening: 'op',
  structure_wall: 'sw', structure_column: 'sc', structure_slab: 'ss',
  beam: 'bm', brace: 'br', foundation: 'f',
  duct: 'du', pipe: 'pi', cable_tray: 'ct', conduit: 'co',
  equipment: 'eq', terminal: 'tm', mep_node: 'mn',
  mesh: 'ms',
};

// Tables whose CSV lives only in global/ (not per-level)
export const GLOBAL_ONLY_TABLES = new Set(['level', 'grid', 'mesh']);

// Tables that can appear in global/ (cross-floor elements)
export const GLOBAL_ALLOWED_TABLES = new Set([
  'level', 'grid', 'stair',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
  'structure_column', 'beam', 'brace',
  'foundation',
]);

// Tables without a geometry file (level/grid use CSV inline; door/window are hosted; mesh is GLB)
const TABLES_WITHOUT_GEOMETRY = new Set(['level', 'grid', 'door', 'window', 'mesh']);

// GeoJSON file name mapping: table name -> geojson file name (without extension)
// GeoJSON files use the same name as the CSV (both singular): wall.csv + wall.geojson
export const GEOJSON_FILE_NAMES: Record<string, string> = Object.fromEntries(
  Object.keys(ID_PREFIXES)
    .filter((k) => !TABLES_WITHOUT_GEOMETRY.has(k))
    .map((k) => [k, k]),
);

// Tables that have a GeoJSON geometry file
export const TABLES_WITH_GEOMETRY = new Set(Object.keys(GEOJSON_FILE_NAMES));

// Tables whose elements use 3D coordinates (spatial line elements).
// Level-anchored tables (wall, slab, column, etc.) use 2D coordinates + Z properties.
export const SPATIAL_3D_TABLES = new Set([
  'stair', 'ramp', 'railing',
  'beam', 'brace',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
]);

let _registry: Map<string, ResolvedTable> | null = null;
let _specDir: string | null = null;

export function buildRegistry(specDir: string): Map<string, ResolvedTable> {
  if (_registry && _specDir === specDir) return _registry;

  const schemas = loadAllSchemas(join(specDir, 'csv-schema'));
  const resolved = new Map<string, ResolvedField[]>();
  const registry = new Map<string, ResolvedTable>();

  for (const [name, schema] of schemas) {
    if (schema.abstract) continue;

    const prefix = ID_PREFIXES[name];
    if (!prefix) continue; // skip unknown concrete schemas

    const allFields = resolveFields(name, schemas, resolved);
    const csvFields = allFields.filter((f) => !f.computed && f.storage === 'csv');
    const geojsonPropertyFields = allFields.filter((f) => !f.computed && f.storage === 'geojson_property');
    const computedFields = allFields.filter((f) => f.computed);

    registry.set(name, {
      name,
      prefix,
      description: schema.description,
      hostType: schema.host_type,
      allFields,
      csvFields,
      geojsonPropertyFields,
      computedFields,
    });
  }

  _registry = registry;
  _specDir = specDir;
  return registry;
}

export function getSpecDir(): string {
  if (process.env.SPEC_DIR) return process.env.SPEC_DIR;

  const thisDir = dirname(fileURLToPath(import.meta.url));

  // 1. In bundled/installed mode: spec is a sibling to index.js (copied by tsup)
  const bundledPath = join(thisDir, 'spec');
  if (existsSync(bundledPath)) return bundledPath;

  // 2. In local dev mode: thisDir is cli/src/schema or cli/dist/spec/.. (if nested)
  // We need to go up until we find where 'spec' is.
  let current = thisDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(current, 'spec');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fallback to project root spec if all else fails
  return join(process.cwd(), 'spec');
}
