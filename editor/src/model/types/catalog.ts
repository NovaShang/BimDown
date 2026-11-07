/**
 * Element types (Revit "family types"): global/<category>_type.csv rows that
 * elements reference through `type_id`, plus the ordered layers of layered
 * types (global/type_layer.csv). Spec: bimdown-spec/spec/readme.md, "Element Types".
 *
 * In memory every typed element's attrs hold EFFECTIVE values (type values
 * filled into the empty type parameters), so renderers, tools and exports need
 * no type awareness. On disk a value equal to the type's is written empty —
 * `stripTypeAttrs` on save, `resolveTypeAttrs` on load — so editing a type
 * reaches every element that follows it; a differing value is an override.
 */
import { getElementModule } from '../../elements/registry.ts';

export type LayerFunction = 'core' | 'substrate' | 'insulation' | 'air_gap' | 'membrane' | 'finish';

export const LAYER_FUNCTIONS: LayerFunction[] = ['core', 'substrate', 'insulation', 'air_gap', 'membrane', 'finish'];

export interface TypeLayer {
  id: string;
  /** 1 = exterior face of a wall (left of start→end) / top face of a slab, roof or ceiling. */
  seq: number;
  function: string;
  material: string;
  thickness: number;
  /** λ, W/(m·K). */
  conductivity?: number;
  name: string;
}

export interface ElementType {
  id: string;
  /** Type table, e.g. `wall_type`. */
  table: string;
  name: string;
  description: string;
  /** Parameter columns (everything but id/name/description), raw CSV strings. */
  values: Record<string, string>;
  /** Sorted by seq; layered types only. */
  layers: TypeLayer[];
}

export interface TypeCatalog {
  types: ElementType[];
  /** False while the project has no type files: the starter catalog is
   *  offered in the UI but written to global/ only once a type is used. */
  saved: boolean;
  /** Set by the loader: the catalog mirrors the files on disk, so it is not
   *  written back (an external edit must not be clobbered by a stale copy). */
  fromDisk?: boolean;
}

export interface TypeTableDef {
  table: string;
  prefix: string;
  /** Instance tables whose `type_id` may point here. */
  instances: string[];
  layered: boolean;
  /** Parameter columns in CSV order (after id, name, description). */
  columns: string[];
}

const FENESTRATION = ['frame_width', 'u_value', 'shgc', 'vt'];
const SECTION = ['shape', 'size_x', 'size_y', 'flange', 'web', 'thickness'];

export const TYPE_TABLE_DEFS: TypeTableDef[] = [
  { table: 'wall_type', prefix: 'wt', instances: ['wall', 'structure_wall'], layered: true, columns: ['material', 'thickness'] },
  { table: 'slab_type', prefix: 'slt', instances: ['slab', 'structure_slab'], layered: true, columns: ['material', 'thickness'] },
  { table: 'roof_type', prefix: 'rot', instances: ['roof'], layered: true, columns: ['material', 'thickness'] },
  { table: 'ceiling_type', prefix: 'clt', instances: ['ceiling'], layered: true, columns: ['material', 'thickness'] },
  { table: 'door_type', prefix: 'dt', instances: ['door'], layered: false, columns: ['material', 'width', 'height', 'operation', ...FENESTRATION] },
  { table: 'window_type', prefix: 'wnt', instances: ['window'], layered: false, columns: ['material', 'width', 'height', 'operation', ...FENESTRATION] },
  { table: 'curtain_wall_type', prefix: 'cwt', instances: ['curtain_wall'], layered: false, columns: ['material', 'u_spacing', 'v_spacing', 'panel_material', 'u_value', 'shgc', 'vt'] },
  { table: 'column_type', prefix: 'colt', instances: ['column', 'structure_column'], layered: false, columns: ['material', ...SECTION] },
  { table: 'beam_type', prefix: 'bmt', instances: ['beam', 'brace'], layered: false, columns: ['material', ...SECTION] },
];

export const TYPE_LAYER_TABLE = 'type_layer';
const LAYER_COLUMNS = ['id', 'type_id', 'seq', 'function', 'material', 'thickness', 'conductivity', 'name'];

const DEF_BY_TABLE = new Map(TYPE_TABLE_DEFS.map(d => [d.table, d]));
const DEF_BY_INSTANCE = new Map(TYPE_TABLE_DEFS.flatMap(d => d.instances.map(i => [i, d] as const)));

/** Project-relative paths of every type file. */
export const TYPE_FILE_PATHS = [...TYPE_TABLE_DEFS.map(d => `global/${d.table}.csv`), `global/${TYPE_LAYER_TABLE}.csv`];

export function typeTableDef(typeTable: string): TypeTableDef | undefined {
  return DEF_BY_TABLE.get(typeTable);
}

/** The type table an instance table uses (wall → wall_type), if any. */
export function typeTableFor(instanceTable: string): TypeTableDef | undefined {
  return DEF_BY_INSTANCE.get(instanceTable);
}

export function isTypedTable(instanceTable: string): boolean {
  return DEF_BY_INSTANCE.has(instanceTable);
}

export const EMPTY_CATALOG: TypeCatalog = { types: [], saved: false };

const EPS = 1e-6;
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Equal as numbers when both parse, else as trimmed strings. */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  const sa = (a ?? '').trim();
  const sb = (b ?? '').trim();
  if (sa === sb) return true;
  if (sa === '' || sb === '') return false;
  const na = Number(sa), nb = Number(sb);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < EPS;
}

export function findType(catalog: TypeCatalog | undefined, id: string | undefined): ElementType | undefined {
  if (!catalog || !id) return undefined;
  return catalog.types.find(t => t.id === id);
}

export function typesOfTable(catalog: TypeCatalog | undefined, typeTable: string): ElementType[] {
  return catalog ? catalog.types.filter(t => t.table === typeTable) : [];
}

/** Types an instance table can use. Architectural columns take rect/round sections only. */
export function typesForInstanceTable(catalog: TypeCatalog | undefined, instanceTable: string): ElementType[] {
  const def = typeTableFor(instanceTable);
  if (!def) return [];
  return typesOfTable(catalog, def.table).filter(t => typeFitsTable(t, instanceTable));
}

export function typeFitsTable(t: ElementType, instanceTable: string): boolean {
  if (typeTableFor(instanceTable)?.table !== t.table) return false;
  if (instanceTable === 'column') return !t.values.shape || t.values.shape === 'rect' || t.values.shape === 'round';
  return true;
}

export function layerTotal(t: ElementType): number | undefined {
  if (t.layers.length === 0) return undefined;
  return round6(t.layers.reduce((s, l) => s + l.thickness, 0));
}

/** Non-empty parameter values; a layered type's thickness is its layer total. */
export function typeValues(t: ElementType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.values)) if (v !== '') out[k] = v;
  const total = layerTotal(t);
  if (total !== undefined) out.thickness = String(total);
  return out;
}

/** Fields an instance table inherits from its type: type columns the table also stores. */
export function typeParamKeys(instanceTable: string): string[] {
  const def = typeTableFor(instanceTable);
  if (!def) return [];
  const headers = new Set(getElementModule(instanceTable)?.csvHeaders ?? []);
  return def.columns.filter(c => headers.has(c));
}

function typeOfAttrs(instanceTable: string, attrs: Record<string, string>, catalog: TypeCatalog | undefined): ElementType | undefined {
  const t = findType(catalog, attrs.type_id);
  return t && typeTableFor(instanceTable)?.table === t.table ? t : undefined;
}

/** The element's type (only if it belongs to the element's type table). */
export function typeOfElement(el: { tableName: string; attrs: Record<string, string> }, catalog: TypeCatalog | undefined): ElementType | undefined {
  return typeOfAttrs(el.tableName, el.attrs, catalog);
}

/** Disk → memory: fill empty type parameters from the type. Returns `attrs` itself when nothing changes. */
export function resolveTypeAttrs(instanceTable: string, attrs: Record<string, string>, catalog: TypeCatalog | undefined): Record<string, string> {
  const t = typeOfAttrs(instanceTable, attrs, catalog);
  if (!t) return attrs;
  const values = typeValues(t);
  let out: Record<string, string> | null = null;
  for (const k of typeParamKeys(instanceTable)) {
    if ((attrs[k] ?? '') !== '' || values[k] === undefined) continue;
    out ??= { ...attrs };
    out[k] = values[k];
  }
  return out ?? attrs;
}

/** Memory → disk: values equal to the type's are written empty. */
export function stripTypeAttrs(instanceTable: string, attrs: Record<string, string>, catalog: TypeCatalog | undefined): Record<string, string> {
  const t = typeOfAttrs(instanceTable, attrs, catalog);
  if (!t) return attrs;
  const values = typeValues(t);
  let out: Record<string, string> | null = null;
  for (const k of typeParamKeys(instanceTable)) {
    if ((attrs[k] ?? '') === '' || values[k] === undefined || !sameValue(attrs[k], values[k])) continue;
    out ??= { ...attrs };
    out[k] = '';
  }
  return out ?? attrs;
}

/** Re-resolve effective attrs after the catalog changed: followers take the new values, overrides stay. */
export function reresolveTypeAttrs(
  instanceTable: string,
  attrs: Record<string, string>,
  before: TypeCatalog | undefined,
  after: TypeCatalog | undefined,
): Record<string, string> {
  if (!attrs.type_id) return attrs;
  const next = resolveTypeAttrs(instanceTable, stripTypeAttrs(instanceTable, attrs, before), after);
  return sameAttrs(next, attrs) ? attrs : next;
}

/**
 * Attrs after switching an element to `typeId` ('' = no type). Overrides of the
 * old type are dropped (the new type's values apply, as in Revit); going
 * untyped keeps the current effective values as plain instance values.
 */
export function retypeAttrs(
  instanceTable: string,
  attrs: Record<string, string>,
  typeId: string,
  catalog: TypeCatalog | undefined,
): Record<string, string> {
  const next: Record<string, string> = { ...attrs, type_id: typeId };
  if (!typeId) return next;
  const t = typeOfAttrs(instanceTable, next, catalog);
  if (!t) return next;
  const values = typeValues(t);
  for (const k of typeParamKeys(instanceTable)) {
    if (values[k] !== undefined) next[k] = values[k];
  }
  return next;
}

/** 'type' when the field shows the type's value, 'override' when the instance differs, null when untyped/not a parameter. */
export function typeParamState(
  instanceTable: string,
  attrs: Record<string, string>,
  key: string,
  catalog: TypeCatalog | undefined,
): 'type' | 'override' | null {
  const t = typeOfAttrs(instanceTable, attrs, catalog);
  if (!t || !typeParamKeys(instanceTable).includes(key)) return null;
  const v = typeValues(t)[key];
  if (v === undefined) return null;
  return sameValue(attrs[key], v) ? 'type' : 'override';
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false;
  return true;
}

// ─── Layers per element ──────────────────────────────────────────────────────

export interface ResolvedLayer extends TypeLayer {
  /** Distance from the exterior (wall) / top (slab, roof, ceiling) face to the layer's near side. */
  offset: number;
}

/**
 * Layers of one element, exterior/top first, at the element's effective
 * thickness: when the element overrides its type's thickness the core layer
 * (else the thickest one) absorbs the difference, or all layers scale when
 * that would leave it non-positive. Null for untyped elements and types
 * without layers. Same rule as the CLI's resolvedLayers (for IFC material
 * layer sets and energy models).
 */
export function resolvedLayers(
  el: { tableName: string; attrs: Record<string, string> },
  catalog: TypeCatalog | undefined,
): ResolvedLayer[] | null {
  const t = typeOfElement(el, catalog);
  if (!t || t.layers.length === 0) return null;
  const layers = t.layers.map(l => ({ ...l }));
  const total = layerTotal(t)!;
  const own = Number(el.attrs.thickness);
  if (el.attrs.thickness && Number.isFinite(own) && own > 0 && Math.abs(own - total) > EPS) {
    const diff = own - total;
    const target = layers.find(l => l.function === 'core') ?? layers.reduce((a, b) => (b.thickness > a.thickness ? b : a));
    if (target.thickness + diff > EPS) {
      target.thickness = round6(target.thickness + diff);
    } else {
      for (const l of layers) l.thickness = round6(l.thickness * (own / total));
    }
  }
  let offset = 0;
  return layers.map(l => {
    const r = { ...l, offset: round6(offset) };
    offset += l.thickness;
    return r;
  });
}

// ─── Editing helpers ─────────────────────────────────────────────────────────

/** Next free `{prefix}-{n}` id among `ids`. */
function nextId(prefix: string, ids: Iterable<string>): string {
  const used = new Set(ids);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function nextTypeId(catalog: TypeCatalog, typeTable: string): string {
  return nextId(typeTableDef(typeTable)?.prefix ?? 'ty', catalog.types.map(t => t.id));
}

export function nextLayerIds(catalog: TypeCatalog, count: number, extra: string[] = []): string[] {
  const used = new Set([...catalog.types.flatMap(t => t.layers.map(l => l.id)), ...extra]);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId('tl', used);
    used.add(id);
    out.push(id);
  }
  return out;
}

/** A copy of `t` with a fresh id, layer ids and a "<name> 2"-style name. */
export function duplicateType(catalog: TypeCatalog, t: ElementType): ElementType {
  const names = new Set(catalog.types.filter(x => x.table === t.table).map(x => x.name));
  const base = t.name;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  const layerIds = nextLayerIds(catalog, t.layers.length);
  return {
    ...t,
    id: nextTypeId(catalog, t.table),
    name: `${base} ${n}`,
    values: { ...t.values },
    layers: t.layers.map((l, i) => ({ ...l, id: layerIds[i] })),
  };
}

/** Layers renumbered 1..n in array order; a layered type's thickness column follows the total. */
export function normalizeType(t: ElementType): ElementType {
  if (!typeTableDef(t.table)?.layered) return t;
  const layers = t.layers.map((l, i) => ({ ...l, seq: i + 1 }));
  const total = layers.length ? round6(layers.reduce((s, l) => s + l.thickness, 0)) : undefined;
  return { ...t, layers, values: { ...t.values, ...(total !== undefined ? { thickness: String(total) } : {}) } };
}

export function upsertType(catalog: TypeCatalog, t: ElementType): TypeCatalog {
  const nt = normalizeType(t);
  const i = catalog.types.findIndex(x => x.id === t.id);
  const types = i >= 0 ? catalog.types.map((x, j) => (j === i ? nt : x)) : [...catalog.types, nt];
  return { types, saved: true };
}

export function removeType(catalog: TypeCatalog, id: string): TypeCatalog {
  return { types: catalog.types.filter(t => t.id !== id), saved: true };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Parse type files (path → content; null/absent = no file) into a catalog's types. */
export function parseTypeFiles(files: Record<string, string | null | undefined>): ElementType[] {
  const types: ElementType[] = [];
  const byId = new Map<string, ElementType>();
  for (const def of TYPE_TABLE_DEFS) {
    const text = files[`global/${def.table}.csv`];
    if (!text) continue;
    for (const row of parseCsv(text)) {
      if (!row.id) continue;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'id' && k !== 'name' && k !== 'description') values[k] = v;
      }
      const t: ElementType = { id: row.id, table: def.table, name: row.name || row.id, description: row.description ?? '', values, layers: [] };
      types.push(t);
      byId.set(t.id, t);
    }
  }
  const layerText = files[`global/${TYPE_LAYER_TABLE}.csv`];
  if (layerText) {
    for (const row of parseCsv(layerText)) {
      const t = byId.get(row.type_id ?? '');
      if (!t || !typeTableDef(t.table)?.layered) continue;
      const th = Number(row.thickness);
      const k = Number(row.conductivity);
      t.layers.push({
        id: row.id ?? '',
        seq: Number(row.seq) || 0,
        function: row.function ?? '',
        material: row.material ?? '',
        thickness: Number.isFinite(th) ? th : 0,
        conductivity: row.conductivity && Number.isFinite(k) ? k : undefined,
        name: row.name ?? '',
      });
    }
  }
  for (const t of types) t.layers.sort((a, b) => a.seq - b.seq);
  return types;
}

/** Every type file's content (header-only for empty categories). */
export function serializeTypeFiles(catalog: TypeCatalog): Record<string, string> {
  const files: Record<string, string> = {};
  for (const def of TYPE_TABLE_DEFS) {
    const types = catalog.types.filter(t => t.table === def.table);
    const extra = new Set<string>();
    for (const t of types) for (const k of Object.keys(t.values)) if (!def.columns.includes(k)) extra.add(k);
    const cols = [...def.columns, ...extra];
    const lines = [['id', 'name', 'description', ...cols].join(',')];
    for (const t of types) {
      lines.push([t.id, t.name, t.description, ...cols.map(c => t.values[c] ?? '')].map(csvCell).join(','));
    }
    files[`global/${def.table}.csv`] = lines.join('\n') + '\n';
  }
  const layerLines = [LAYER_COLUMNS.join(',')];
  for (const t of catalog.types) {
    for (const l of t.layers) {
      layerLines.push([
        l.id, t.id, String(l.seq), l.function, l.material, String(l.thickness),
        l.conductivity !== undefined ? String(l.conductivity) : '', l.name,
      ].map(csvCell).join(','));
    }
  }
  files[`global/${TYPE_LAYER_TABLE}.csv`] = layerLines.join('\n') + '\n';
  return files;
}
