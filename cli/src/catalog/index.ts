/**
 * Element types (Revit "family types"): global/<category>_type.csv rows that
 * instances reference through `type_id`, plus the ordered layers of layered
 * types in global/type_layer.csv.
 *
 * Resolution rule (spec readme, "Element Types"): a field shared by name between
 * a type table and its instance table is a type parameter. An empty instance
 * value inherits the type's value; a set value overrides it. A layered type's
 * thickness is the sum of its layers when the type leaves `thickness` empty.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from '../utils/csv.js';
import { discoverLayout } from '../utils/fs.js';
import { buildRegistry, getSpecDir, TYPE_TABLES, LAYERED_TYPE_TABLES } from '../schema/registry.js';

export interface TypeLayer {
  id: string;
  seq: number;
  function: string;
  material: string;
  thickness: number;
  conductivity?: number;
  name: string;
}

export interface ElementType {
  id: string;
  /** Type table, e.g. `wall_type`. */
  table: string;
  row: Record<string, string>;
  /** Layers sorted by `seq` (layered types only; empty otherwise). */
  layers: TypeLayer[];
}

export interface TypeCatalog {
  types: Map<string, ElementType>;
}

/** A layer as it applies to one element: thickness adjusted to the element's
 *  effective thickness and its offset from the exterior / top face. */
export interface ResolvedLayer extends TypeLayer {
  /** Distance from the exterior (wall) / top (slab, roof, ceiling) face to the layer's near side. */
  offset: number;
}

/** Columns of a type table that describe the type rather than parameterize instances. */
const TYPE_META_FIELDS = new Set(['id', 'name', 'description']);

const EPS = 1e-6;

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Equal as numbers when both parse, else as trimmed strings. */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  const sa = (a ?? '').trim();
  const sb = (b ?? '').trim();
  if (sa === sb) return true;
  if (sa === '' || sb === '') return false;
  const na = Number(sa);
  const nb = Number(sb);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < EPS;
}

/** Build a catalog from already-read rows (type tables + type_layer). */
export function catalogFromRows(
  typeRows: { table: string; rows: Record<string, string>[] }[],
  layerRows: Record<string, string>[],
): TypeCatalog {
  const types = new Map<string, ElementType>();
  for (const { table, rows } of typeRows) {
    for (const row of rows) {
      if (!row.id) continue;
      types.set(row.id, { id: row.id, table, row, layers: [] });
    }
  }
  for (const row of layerRows) {
    const t = types.get(row.type_id ?? '');
    if (!t || !LAYERED_TYPE_TABLES.has(t.table)) continue;
    const thickness = Number(row.thickness);
    const conductivity = Number(row.conductivity);
    t.layers.push({
      id: row.id ?? '',
      seq: Number(row.seq) || 0,
      function: row.function ?? '',
      material: row.material ?? '',
      thickness: Number.isFinite(thickness) ? thickness : 0,
      conductivity: row.conductivity && Number.isFinite(conductivity) ? conductivity : undefined,
      name: row.name ?? '',
    });
  }
  for (const t of types.values()) t.layers.sort((a, b) => a.seq - b.seq);
  return { types };
}

const cache = new Map<string, { sig: string; catalog: TypeCatalog }>();

function typeFilePaths(globalDir: string): { table: string; path: string }[] {
  return [...TYPE_TABLES, 'type_layer'].map((table) => ({ table, path: join(globalDir, `${table}.csv`) }));
}

/** Load the project's type catalog from global/ (cached until a type file changes). */
export function loadCatalog(projectDir: string): TypeCatalog {
  const globalDir = join(projectDir, 'global');
  const files = typeFilePaths(globalDir).filter((f) => existsSync(f.path));
  const sig = files.map((f) => {
    const st = statSync(f.path);
    return `${f.table}:${st.mtimeMs}:${st.size}`;
  }).join('|');
  const hit = cache.get(projectDir);
  if (hit && hit.sig === sig) return hit.catalog;

  const typeRows: { table: string; rows: Record<string, string>[] }[] = [];
  let layerRows: Record<string, string>[] = [];
  for (const f of files) {
    let rows: Record<string, string>[];
    try { rows = readCsv(f.path).rows; } catch { continue; }
    if (f.table === 'type_layer') layerRows = rows;
    else typeRows.push({ table: f.table, rows });
  }
  const catalog = catalogFromRows(typeRows, layerRows);
  cache.set(projectDir, { sig, catalog });
  return catalog;
}

/** Sum of a type's layer thicknesses, or undefined when it has no layers. */
export function layerTotal(t: ElementType): number | undefined {
  if (t.layers.length === 0) return undefined;
  return round6(t.layers.reduce((s, l) => s + l.thickness, 0));
}

/** The type's parameter values (non-empty columns other than id/name/description),
 *  with thickness derived from the layers when the type leaves it empty. */
export function typeValues(t: ElementType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.row)) {
    if (TYPE_META_FIELDS.has(k) || v === undefined || v === '') continue;
    out[k] = v;
  }
  if (!out.thickness) {
    const total = layerTotal(t);
    if (total !== undefined) out.thickness = String(total);
  }
  return out;
}

const paramFieldCache = new Map<string, string[]>();

/** Field names an instance table inherits from its type table (shared by name). */
export function typeParamFields(instanceTable: string): string[] {
  const cached = paramFieldCache.get(instanceTable);
  if (cached) return cached;
  const registry = buildRegistry(getSpecDir());
  const inst = registry.get(instanceTable);
  const typeTable = inst?.typeTable ? registry.get(inst.typeTable) : undefined;
  let fields: string[] = [];
  if (inst && typeTable) {
    const typeCols = new Set(typeTable.csvFields.map((f) => f.name));
    fields = inst.csvFields
      .map((f) => f.name)
      .filter((n) => typeCols.has(n) && !TYPE_META_FIELDS.has(n) && n !== 'type_id');
  }
  paramFieldCache.set(instanceTable, fields);
  return fields;
}

/** The type an instance row points at, if it exists and belongs to the instance's type table. */
export function typeOfRow(
  instanceTable: string,
  row: Record<string, string>,
  catalog: TypeCatalog,
): ElementType | undefined {
  const id = row.type_id;
  if (!id) return undefined;
  const t = catalog.types.get(id);
  if (!t) return undefined;
  const registry = buildRegistry(getSpecDir());
  return registry.get(instanceTable)?.typeTable === t.table ? t : undefined;
}

/** The row with every empty type parameter filled from its type. */
export function effectiveRow(
  instanceTable: string,
  row: Record<string, string>,
  catalog: TypeCatalog,
): Record<string, string> {
  const t = typeOfRow(instanceTable, row, catalog);
  if (!t) return row;
  const values = typeValues(t);
  const out = { ...row };
  for (const f of typeParamFields(instanceTable)) {
    if ((out[f] ?? '') === '' && values[f] !== undefined) out[f] = values[f];
  }
  return out;
}

/** effectiveRow for every row, loading the catalog of `projectDir`. */
export function effectiveRows(
  projectDir: string,
  instanceTable: string,
  rows: Record<string, string>[],
): Record<string, string>[] {
  if (!buildRegistry(getSpecDir()).get(instanceTable)?.typeTable) return rows;
  const catalog = loadCatalog(projectDir);
  if (catalog.types.size === 0) return rows;
  return rows.map((r) => effectiveRow(instanceTable, r, catalog));
}

/**
 * Layers of one element, exterior/top first. When the element overrides the
 * type's thickness the core layer (or, without one, the thickest layer) absorbs
 * the difference; if that would leave it non-positive the layers are scaled.
 * Returns null for untyped elements and types without layers.
 */
export function resolvedLayers(
  instanceTable: string,
  row: Record<string, string>,
  catalog: TypeCatalog,
): ResolvedLayer[] | null {
  const t = typeOfRow(instanceTable, row, catalog);
  if (!t || t.layers.length === 0) return null;
  const layers = t.layers.map((l) => ({ ...l }));
  const total = layerTotal(t)!;
  const own = Number(row.thickness);
  if (row.thickness && Number.isFinite(own) && own > 0 && Math.abs(own - total) > EPS) {
    const diff = own - total;
    let target = layers.find((l) => l.function === 'core');
    if (!target) target = layers.reduce((a, b) => (b.thickness > a.thickness ? b : a));
    if (target.thickness + diff > EPS) {
      target.thickness = round6(target.thickness + diff);
    } else {
      const k = own / total;
      for (const l of layers) l.thickness = round6(l.thickness * k);
    }
  }
  let offset = 0;
  return layers.map((l) => {
    const r = { ...l, offset: round6(offset) };
    offset += l.thickness;
    return r;
  });
}

/** Rows of every instance table whose type is layered, per directory. */
function forEachLayeredInstanceRow(
  projectDir: string,
  visit: (table: string, dirName: string, row: Record<string, string>, index: number) => void,
): void {
  const registry = buildRegistry(getSpecDir());
  const layout = discoverLayout(projectDir);
  for (const d of [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs]) {
    for (const [table, def] of registry) {
      if (!def.typeTable || !LAYERED_TYPE_TABLES.has(def.typeTable)) continue;
      const p = join(d.path, `${table}.csv`);
      if (!existsSync(p)) continue;
      let rows: Record<string, string>[];
      try { rows = readCsv(p).rows; } catch { continue; }
      rows.forEach((row, i) => visit(table, d.name, row, i));
    }
  }
}

/** Instance rows that override a layered type's thickness (build warnings). */
export function typeWarnings(projectDir: string): string[] {
  const catalog = loadCatalog(projectDir);
  if (catalog.types.size === 0) return [];
  const warnings: string[] = [];
  forEachLayeredInstanceRow(projectDir, (table, dirName, row, i) => {
    const t = typeOfRow(table, row, catalog);
    if (!t || !row.thickness) return;
    const total = layerTotal(t);
    if (total === undefined || sameValue(row.thickness, String(total))) return;
    warnings.push(
      `[warn] ${dirName}/${table}.csv:${i + 2}  ${row.id} thickness=${row.thickness} overrides ${t.id} (layers total ${total}); its core layer absorbs the difference — clear thickness to follow the type`,
    );
  });
  return warnings;
}

export interface ElementLayers {
  table: string;
  /** `global` or the level directory (lv-N). */
  level: string;
  id: string;
  typeId: string;
  layers: ResolvedLayer[];
}

/** Resolved layers of every typed element in the project (e.g. for IFC material layer sets). */
export function projectElementLayers(projectDir: string): ElementLayers[] {
  const catalog = loadCatalog(projectDir);
  if (catalog.types.size === 0) return [];
  const out: ElementLayers[] = [];
  forEachLayeredInstanceRow(projectDir, (table, dirName, row) => {
    const layers = resolvedLayers(table, row, catalog);
    if (layers) out.push({ table, level: dirName, id: row.id, typeId: row.type_id, layers });
  });
  return out;
}
