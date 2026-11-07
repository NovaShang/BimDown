/**
 * Schedule definitions (rooms, doors, windows, walls, slabs, columns,
 * framing, MEP runs, equipment) and the pure table logic behind the
 * Schedule view: rows across all levels, sorting, grouping with subtotals,
 * totals, CSV text.
 */
import type { CanonicalElement } from '../model/elements.ts';
import type { Level, ProjectData, ProjectUnit } from '../types.ts';
import { collectLevels, elementQuantities } from './quantities.ts';
import type { ElementQuantities } from './quantities.ts';
import { boundaryWalls, roomPolygon } from '../annotation/rooms.ts';
import { pointInPolygon } from '../geometry/spaceBoundary.ts';
import { resolveFurniture } from '../library/furnitureLibrary.generated.ts';
import { circuitsIn, type CircuitSummary } from '../mep/circuits.ts';
import { FOUNDATION_KIND_OPTIONS, OPERATION_OPTIONS, WINDOW_OPERATION_OPTIONS } from '../elements/_options.ts';
import { drawingLabel, drawingLang, type DrawingLang } from '../export/drawing/labels.ts';
import { typeOfElement, type TypeCatalog } from '../model/types/catalog.ts';
import { foundationKind } from '../elements/foundation.tsx';
import { unitsPerMetreOf } from '../utils/units.ts';

export type ColumnKind = 'text' | 'length' | 'area' | 'volume' | 'count' | 'weight';

export interface ScheduleColumn {
  key: string;
  /** i18n key */
  label: string;
  kind: ColumnKind;
  /** Sum in group / grand totals. */
  total?: boolean;
  /** Shown before the user customises columns. */
  defaultOn?: boolean;
}

export interface ScheduleCategory {
  key: string;
  label: string;
  tables: string[];
  columns: ScheduleColumn[];
  /** Initial group-by column ('' = none). */
  groupBy?: string;
  /** Only rows this accepts (e.g. accessories among mep_node rows). */
  filter?: (el: CanonicalElement) => boolean;
}

export interface ScheduleRow {
  /** Selection id ("lv-1:w-3"). */
  sid: string;
  id: string;
  levelId: string;
  table: string;
  values: Record<string, string | number | undefined>;
}

const C = (key: string, label: string, kind: ColumnKind, defaultOn = true, total = false): ScheduleColumn => ({ key, label, kind, defaultOn, total });

const LEVEL = C('level', 'schedule.col.level', 'text');
const NUMBER = C('number', 'schedule.col.number', 'text');
const CATEGORY = C('category', 'schedule.col.category', 'text');
const MATERIAL = C('material', 'schedule.col.material', 'text');
const COUNT = C('count', 'schedule.col.count', 'count', false, true);
const TYPE_NAME = C('type_name', 'schedule.col.typeName', 'text');
const GRADE = C('grade', 'schedule.col.grade', 'text');
const WEIGHT = C('weight', 'schedule.col.weight', 'weight', true, true);

export const SCHEDULES: ScheduleCategory[] = [
  {
    key: 'rooms', label: 'schedule.rooms', tables: ['space'],
    columns: [NUMBER, C('name', 'schedule.col.name', 'text'), LEVEL,
      // Net area at the wall faces (Revit's default); the centre-line area as an optional column
      C('area', 'schedule.col.area', 'area', true, true), C('gross_area', 'schedule.col.grossAreaCentreline', 'area', false, true),
      C('perimeter', 'schedule.col.perimeter', 'length', true, true), COUNT],
  },
  {
    // Host = the wall's mark / type, not its internal id
    key: 'doors', label: 'schedule.doors', tables: ['door'],
    columns: [NUMBER, LEVEL, TYPE_NAME, C('host', 'schedule.col.host', 'text'), C('width', 'schedule.col.width', 'length'),
      C('height', 'schedule.col.height', 'length'), C('operation', 'schedule.col.operation', 'text'), MATERIAL, COUNT],
  },
  {
    key: 'windows', label: 'schedule.windows', tables: ['window'],
    columns: [NUMBER, LEVEL, TYPE_NAME, C('host', 'schedule.col.host', 'text'), C('width', 'schedule.col.width', 'length'),
      C('height', 'schedule.col.height', 'length'), C('base_offset', 'schedule.col.sill', 'length'), MATERIAL, COUNT],
  },
  {
    key: 'walls', label: 'schedule.walls', tables: ['wall', 'structure_wall', 'curtain_wall'], groupBy: '',
    columns: [NUMBER, LEVEL, CATEGORY, { ...TYPE_NAME, defaultOn: false }, MATERIAL, { ...GRADE, defaultOn: false }, C('thickness', 'schedule.col.thickness', 'length'),
      C('length', 'schedule.col.length', 'length', true, true), C('qheight', 'schedule.col.height', 'length'),
      C('area', 'schedule.col.netArea', 'area', true, true), C('gross_area', 'schedule.col.grossArea', 'area', false, true),
      C('volume', 'schedule.col.volume', 'volume', true, true), COUNT],
  },
  {
    // Area / volume net of the floor openings hosted on the slab
    key: 'slabs', label: 'schedule.slabs', tables: ['slab', 'structure_slab', 'roof', 'ceiling'],
    columns: [NUMBER, LEVEL, CATEGORY, { ...TYPE_NAME, defaultOn: false }, C('function', 'schedule.col.function', 'text'), MATERIAL,
      { ...GRADE, defaultOn: false }, C('thickness', 'schedule.col.thickness', 'length'), C('area', 'schedule.col.netArea', 'area', true, true),
      C('gross_area', 'schedule.col.grossArea', 'area', false, true),
      C('perimeter', 'schedule.col.perimeter', 'length', false, true), C('volume', 'schedule.col.volume', 'volume', true, true), COUNT],
  },
  {
    // Structural take-off: per type and grade, concrete volume and steel weight
    key: 'columns', label: 'schedule.columns', tables: ['column', 'structure_column'], groupBy: 'type_name',
    columns: [NUMBER, LEVEL, CATEGORY, TYPE_NAME, C('shape', 'schedule.col.shape', 'text', false), C('size', 'schedule.col.size', 'text'),
      MATERIAL, GRADE, C('qheight', 'schedule.col.height', 'length', true, true), C('volume', 'schedule.col.volume', 'volume', true, true),
      WEIGHT, C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'framing', label: 'schedule.framing', tables: ['beam', 'brace'], groupBy: 'type_name',
    columns: [NUMBER, LEVEL, CATEGORY, TYPE_NAME, C('size', 'schedule.col.size', 'text'), MATERIAL, GRADE,
      C('length', 'schedule.col.length', 'length', true, true), C('volume', 'schedule.col.volume', 'volume', true, true),
      WEIGHT, C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'foundations', label: 'schedule.foundations', tables: ['foundation'], groupBy: 'kind',
    columns: [NUMBER, LEVEL, C('kind', 'schedule.col.kind', 'text'), TYPE_NAME, C('size', 'schedule.col.size', 'text'), MATERIAL, GRADE,
      C('thickness', 'schedule.col.depthLength', 'length'), C('area', 'schedule.col.area', 'area', false, true),
      C('volume', 'schedule.col.volume', 'volume', true, true), C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'mep', label: 'schedule.mep', tables: ['duct', 'pipe', 'conduit', 'cable_tray'], groupBy: 'system_type',
    columns: [CATEGORY, C('system_type', 'schedule.col.system', 'text'), C('size', 'schedule.col.size', 'text'),
      C('insulation', 'schedule.col.insulation', 'length'), LEVEL,
      NUMBER, C('length', 'schedule.col.length', 'length', true, true), C('count', 'schedule.col.count', 'count', false, true)],
  },
  {
    // Inline accessories (valves, dampers, strainers …); passive fittings are not listed
    key: 'accessories', label: 'schedule.accessories', tables: ['mep_node'], groupBy: 'kind',
    filter: el => !!(el.attrs.kind ?? '').trim(),
    columns: [C('kind', 'schedule.col.kind', 'text'), C('system_type', 'schedule.col.system', 'text'), C('size', 'schedule.col.size', 'text'),
      LEVEL, NUMBER, C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    // Electrical circuits with their connected load (sum of the devices' load)
    key: 'circuits', label: 'schedule.circuits', tables: ['circuit'], groupBy: 'panel',
    columns: [C('panel', 'schedule.col.panel', 'text'), NUMBER, C('name', 'schedule.col.name', 'text'), LEVEL,
      C('voltage', 'schedule.col.voltage', 'text'), C('rating', 'schedule.col.rating', 'text'),
      C('devices', 'schedule.col.devices', 'count', true, true), C('load_w', 'schedule.col.loadW', 'count', true, true)],
  },
  {
    // Library components: count by family / variant, with the room they stand in
    key: 'furniture', label: 'schedule.furniture', tables: ['furniture'], groupBy: 'family_variant',
    columns: [C('family_variant', 'schedule.col.familyVariant', 'text'), C('room', 'schedule.col.room', 'text'), LEVEL, NUMBER,
      C('size', 'schedule.col.size', 'text'), C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'equipment', label: 'schedule.equipment', tables: ['equipment', 'terminal'], groupBy: 'type',
    columns: [NUMBER, LEVEL, CATEGORY, C('type', 'schedule.col.type', 'text'), C('system_type', 'schedule.col.system', 'text'),
      C('count', 'schedule.col.count', 'count', true, true)],
  },
];

/** Section / size descriptor in project units ("300×600", "Ø150"). */
export function sizeLabel(el: CanonicalElement, unit: ProjectUnit): string {
  const f = (v: string | undefined) => {
    const n = parseFloat(v ?? '');
    if (!Number.isFinite(n)) return '';
    return unit === 'm' ? String(Math.round(n * 1000)) : String(Number(n.toFixed(unit === 'mm' ? 0 : 2)));
  };
  if (el.tableName === 'foundation') {
    const w = f(el.attrs.width), l = f(el.attrs.length);
    const kind = foundationKind(el);
    if (kind === 'pile' && !l) return w ? `Ø${w}` : '';
    if (el.geometry === 'point') return w ? `${w}×${l || w}` : '';
    return el.geometry === 'line' ? w : '';
  }
  if (el.attrs.designation) return el.attrs.designation;
  const sx = f(el.attrs.size_x), sy = f(el.attrs.size_y);
  if ((el.attrs.shape === 'round' || el.attrs.shape === 'round_hollow') && sx) return `Ø${sx}`;
  if (sx && sy) return `${sx}×${sy}`;
  return sx;
}

/** Door / window operation as its option label in `lang` (single_swing → "Single" / 单开); unknown values stay raw. */
export function operationLabel(table: string, value: string | undefined, lang: DrawingLang = drawingLang()): string {
  if (!value) return '';
  const opts = table === 'window' ? WINDOW_OPERATION_OPTIONS : table === 'door' ? OPERATION_OPTIONS : undefined;
  const label = opts?.find(o => o.value === value)?.label;
  return label ? drawingLabel(lang, `option.${label}`) : value;
}

/** Foundation kind as its option label (empty kind = the geometry's default). */
function kindLabel(el: CanonicalElement, lang: DrawingLang): string {
  if (el.tableName !== 'foundation') return el.attrs.kind ?? '';
  const k = foundationKind(el);
  const label = FOUNDATION_KIND_OPTIONS?.find(o => o.value === k)?.label;
  return label ? drawingLabel(lang, `option.${label}`) : k;
}

/** A hosted element's host as people name it: mark and type ("W12 · Brick cavity"), id only as a fallback. */
function hostLabel(el: CanonicalElement, context: CanonicalElement[], types: TypeCatalog | undefined): string {
  const hid = el.attrs.host_id || el.hostId || '';
  if (!hid) return '';
  const host = context.find(e => e.id === hid);
  if (!host) return hid;
  const parts = [host.attrs.number, typeOfElement(host, types)?.name].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : hid;
}

function rowValues(el: CanonicalElement, level: Level, q: ElementQuantities, unit: ProjectUnit, displayName: (table: string) => string, lang: DrawingLang,
  types?: TypeCatalog, context: CanonicalElement[] = []): Record<string, string | number | undefined> {
  const a = el.attrs;
  const num = (v: string | undefined) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    number: a.number ?? '',
    name: a.name ?? '',
    level: level.name || level.id,
    category: displayName(el.tableName),
    material: a.material ?? '',
    host_id: a.host_id ?? el.hostId ?? '',
    width: num(a.width),
    height: num(a.height),
    base_offset: num(a.base_offset),
    operation: operationLabel(el.tableName, a.operation, lang),
    thickness: num(a.thickness),
    function: a.function ?? '',
    shape: a.shape ?? '',
    size: sizeLabel(el, unit),
    system_type: a.system_type ?? '',
    type: a.equipment_type || a.terminal_type || a.type || a.family || '',
    kind: kindLabel(el, lang),
    type_name: typeOfElement(el, types)?.name ?? '',
    grade: a.material_grade ?? '',
    host: hostLabel(el, context, types),
    weight: q.weight,
    insulation: num(a.insulation_thickness) || undefined,
    length: q.length,
    qheight: q.height,
    area: q.area,
    gross_area: q.gross_area,
    volume: q.volume,
    perimeter: q.perimeter,
    count: 1,
  };
}

interface LevelRoom { label: string; poly: { x: number; y: number }[] }

/** The level's rooms with their outline (smallest first, so a nested room wins). */
function levelRooms(elements: CanonicalElement[], context: CanonicalElement[]): LevelRoom[] {
  const walls = boundaryWalls(context);
  const out: (LevelRoom & { area: number })[] = [];
  for (const el of elements) {
    if (el.tableName !== 'space') continue;
    const poly = roomPolygon(el, walls);
    if (!poly) continue;
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    out.push({ label: [el.attrs.number, el.attrs.name].filter(Boolean).join(' ') || el.id, poly, area: Math.abs(a) / 2 });
  }
  return out.sort((x, y) => x.area - y.area);
}

/** Circuit rows: panel tag, connected devices and load. */
function circuitValues(el: CanonicalElement, circuits: Map<string, CircuitSummary>, context: CanonicalElement[]): Record<string, string | number> {
  const c = circuits.get(el.id);
  const panelId = c?.panelId ?? el.attrs.host_id ?? '';
  const panel = context.find(e => e.id === panelId);
  const load = c?.load ?? 0;
  return {
    panel: panel?.attrs.number || panel?.attrs.type || panel?.attrs.family || panelId,
    voltage: el.attrs.voltage ? `${el.attrs.voltage} V` : '',
    rating: el.attrs.rating ? `${el.attrs.rating} A` : '',
    devices: c?.devices.length ?? 0,
    load_w: Math.round(load),
  };
}

/** Furniture rows: "Family · Variant" in the UI language, and the room it stands in. */
function furnitureValues(el: CanonicalElement, rooms: LevelRoom[], lang: DrawingLang): Record<string, string> {
  const r = resolveFurniture(el.attrs);
  const zh = lang === 'zh';
  const name = (o: { en: string; zh: string }) => (zh ? o.zh : o.en);
  const variant = r.family.variants?.find(v => v.id === r.params.variant);
  const at = el.geometry === 'point' ? el.position : undefined;
  const room = at ? rooms.find(rm => pointInPolygon(at.x, at.y, rm.poly)) : undefined;
  return {
    family_variant: variant ? `${name(r.family)} · ${name(variant)}` : name(r.family),
    room: room?.label ?? '',
  };
}

/** All rows of a schedule across every level. */
export function scheduleRows(
  cat: ScheduleCategory, project: ProjectData, unit: ProjectUnit,
  displayName: (table: string) => string,
  liveLevel?: string, live?: Map<string, CanonicalElement>,
  lang: DrawingLang = drawingLang(),
): ScheduleRow[] {
  const { levels, global } = collectLevels(project, liveLevel, live);
  const allLevels = levels.map(l => l.level);
  const tables = new Set(cat.tables);
  const rows: ScheduleRow[] = [];
  const lowest = allLevels[0];
  const roomCache = new Map<string, LevelRoom[]>();
  const circuitCache = new Map<string, Map<string, CircuitSummary>>();
  const circuits = (levelId: string, context: CanonicalElement[]) => {
    let c = circuitCache.get(levelId);
    if (!c) circuitCache.set(levelId, c = new Map(circuitsIn(new Map(context.map(e => [e.id, e]))).map(x => [x.id, x])));
    return c;
  };
  const rooms = (levelId: string, elements: CanonicalElement[], context: CanonicalElement[]) => {
    let r = roomCache.get(levelId);
    if (!r) roomCache.set(levelId, r = levelRooms(elements, context));
    return r;
  };
  const upm = unitsPerMetreOf(unit);
  for (const { level, elements } of levels) {
    const context = [...elements, ...global];
    for (const el of elements) {
      if (!tables.has(el.tableName)) continue;
      const q = elementQuantities(el, level, allLevels, context, upm);
      const values = rowValues(el, level, q, unit, displayName, lang, project.types, context);
      if (cat.filter && !cat.filter(el)) continue;
      if (el.tableName === 'furniture') Object.assign(values, furnitureValues(el, rooms(level.id, elements, context), lang));
      if (el.tableName === 'circuit') Object.assign(values, circuitValues(el, circuits(level.id, context), context));
      rows.push({ sid: `${level.id}:${el.id}`, id: el.id, levelId: level.id, table: el.tableName, values });
    }
  }
  // Multi-storey elements in global/ count once, on their base level
  for (const el of global) {
    if (!tables.has(el.tableName) || !lowest) continue;
    const level = allLevels.find(l => l.id === el.attrs.base_level_id) ?? lowest;
    const context = [...(levels.find(l => l.level.id === level.id)?.elements ?? []), ...global];
    const q = elementQuantities(el, level, allLevels, context, upm);
    rows.push({ sid: `global:${el.id}`, id: el.id, levelId: 'global', table: el.tableName, values: rowValues(el, level, q, unit, displayName, lang, project.types, context) });
  }
  return rows;
}

export type SortState = { key: string; dir: 1 | -1 } | null;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRows(rows: ScheduleRow[], sort: SortState): ScheduleRow[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const x = a.values[sort.key], y = b.values[sort.key];
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
    return c * sort.dir;
  });
}

export interface RowGroup {
  key: string;
  rows: ScheduleRow[];
  totals: Record<string, number>;
}

export function totalsOf(rows: ScheduleRow[], columns: ScheduleColumn[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const c of columns) {
    if (!c.total) continue;
    let s = 0;
    for (const r of rows) {
      const v = r.values[c.key];
      if (typeof v === 'number') s += v;
    }
    t[c.key] = s;
  }
  return t;
}

/** Group rows by a column value ('' = one group), keeping first-seen order (after sorting). */
export function groupRows(rows: ScheduleRow[], groupBy: string, columns: ScheduleColumn[]): RowGroup[] {
  if (!groupBy) return [{ key: '', rows, totals: totalsOf(rows, columns) }];
  const map = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    const k = String(r.values[groupBy] ?? '');
    const list = map.get(k) ?? [];
    list.push(r);
    map.set(k, list);
  }
  const keys = [...map.keys()].sort((a, b) => collator.compare(a, b));
  return keys.map(k => ({ key: k, rows: map.get(k)!, totals: totalsOf(map.get(k)!, columns) }));
}

/** Cell text in project units. */
export function formatCell(v: string | number | undefined, kind: ColumnKind, unit: ProjectUnit): string {
  if (v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  switch (kind) {
    case 'count': return String(v);
    case 'length': return v.toFixed(unit === 'mm' ? 0 : unit === 'm' ? 3 : 2);
    case 'area': return v.toFixed(unit === 'mm' ? 0 : 2);
    case 'volume': return v.toFixed(unit === 'mm' ? 0 : 3);
    case 'weight': return v.toFixed(1);
    default: return String(v);
  }
}

export function unitSuffix(kind: ColumnKind, unit: ProjectUnit): string {
  if (kind === 'length') return unit;
  if (kind === 'area') return `${unit}²`;
  if (kind === 'volume') return `${unit}³`;
  if (kind === 'weight') return 'kg';
  return '';
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text: header, rows (numbers unformatted, full precision rounded to 6), group subtotals and a total line. */
export function scheduleCsv(groups: RowGroup[], columns: ScheduleColumn[], header: string[], totalLabel: string): string {
  const lines = [header.map(csvCell).join(',')];
  const cell = (v: string | number | undefined) => (typeof v === 'number' ? String(Number(v.toFixed(6))) : csvCell(v ?? ''));
  for (const g of groups) {
    for (const r of g.rows) lines.push(columns.map(c => cell(r.values[c.key])).join(','));
    if (groups.length > 1) lines.push(columns.map((c, i) => (i === 0 ? csvCell(`${totalLabel}: ${g.key || '—'}`) : c.total ? cell(g.totals[c.key]) : '')).join(','));
  }
  const all = groups.flatMap(g => g.rows);
  const grand = totalsOf(all, columns);
  lines.push(columns.map((c, i) => (i === 0 ? csvCell(totalLabel) : c.total ? cell(grand[c.key]) : '')).join(','));
  return lines.join('\n') + '\n';
}
