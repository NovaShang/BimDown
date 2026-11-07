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
  connector: 'cn',
  mep_system: 'sys',
  view: 'vw',
  mesh: 'ms',
  // Element types (global/ only) and the layers of layered types
  wall_type: 'wt', slab_type: 'slt', roof_type: 'rot', ceiling_type: 'clt',
  door_type: 'dt', window_type: 'wnt', curtain_wall_type: 'cwt',
  column_type: 'colt', beam_type: 'bmt',
  type_layer: 'tl',
  // Annotations
  dimension: 'dm', text_note: 'tx', tag: 'tg',
  // Tracing references
  underlay: 'ul',
};

/** Type tables (Revit "family types"). Each lists the instance tables that may reference it via `type_id`. */
export const TYPE_TABLES = new Set([
  'wall_type', 'slab_type', 'roof_type', 'ceiling_type',
  'door_type', 'window_type', 'curtain_wall_type',
  'column_type', 'beam_type',
]);

/** Type tables whose build-up is a stack of type_layer rows. */
export const LAYERED_TYPE_TABLES = new Set(['wall_type', 'slab_type', 'roof_type', 'ceiling_type']);

// Annotation tables: CSV-only plan annotations, allowed in level directories only.
export const ANNOTATION_TABLES = new Set(['dimension', 'text_note', 'tag']);

// Tables whose CSV lives only in global/ (not per-level)
export const GLOBAL_ONLY_TABLES = new Set(['level', 'grid', 'mesh', 'mep_system', 'view', 'underlay', ...TYPE_TABLES, 'type_layer']);

// Tables that can appear in global/ (cross-floor elements)
export const GLOBAL_ALLOWED_TABLES = new Set([
  'level', 'grid', 'view', 'stair',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
  'connector',
  'structure_column', 'beam', 'brace',
  'foundation',
]);

// Tables without a geometry file (level/grid use CSV inline; door/window are hosted; mesh is GLB;
// mep_system is a project-wide lookup table with no geometry; connector is a CSV-only port
// on its host equipment / terminal / mep_node, position is derived from host + offsets;
// view rows carry their plan line inline like grid; underlay is a tracing reference
// whose source file lives in underlays/)
const TABLES_WITHOUT_GEOMETRY = new Set([
  'level', 'grid', 'door', 'window', 'mesh', 'mep_system', 'connector', 'view', 'underlay',
  ...TYPE_TABLES, 'type_layer',
  ...ANNOTATION_TABLES,
]);

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

    const typeRef = allFields.find((f) => f.name === 'type_id' && f.type === 'reference')?.reference;
    registry.set(name, {
      name,
      prefix,
      description: schema.description,
      hostType: schema.host_type,
      typeTable: typeRef && TYPE_TABLES.has(typeRef) ? typeRef : undefined,
      typeOf: schema.type_of,
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
