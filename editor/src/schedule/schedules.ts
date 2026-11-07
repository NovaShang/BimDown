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
import { MEP_SCHEDULES, mepValueFn } from './mepSchedules.ts';
import { OPERATION_OPTIONS, WINDOW_OPERATION_OPTIONS } from '../elements/_options.ts';
import { drawingLabel, drawingLang, type DrawingLang } from '../export/drawing/labels.ts';

export type ColumnKind = 'text' | 'length' | 'area' | 'volume' | 'count';

export interface ScheduleColumn {
  key: string;
  /** i18n key */
  label: string;
  kind: ColumnKind;
  /** Sum in group / grand totals. */
  total?: boolean;
  /** Shown before the user customises columns. */
  defaultOn?: boolean;
  /** Decimals shown and exported (per project unit, or one for all). */
  digits?: number | Partial<Record<ProjectUnit, number>>;
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
  /** false: one row per group (totals summed) until the user ticks "Itemize". */
  itemize?: boolean;
}

export interface ScheduleRow {
  /** Selection id ("lv-1:w-3"). */
  sid: string;
  id: string;
  levelId: string;
  table: string;
  values: Record<string, string | number | undefined>;
  /** Rows a collapsed (non-itemized) group row stands for. */
  members?: { sid: string; levelId: string }[];
}

const C = (key: string, label: string, kind: ColumnKind, defaultOn = true, total = false): ScheduleColumn => ({ key, label, kind, defaultOn, total });

const LEVEL = C('level', 'schedule.col.level', 'text');
const NUMBER = C('number', 'schedule.col.number', 'text');
const CATEGORY = C('category', 'schedule.col.category', 'text');
const MATERIAL = C('material', 'schedule.col.material', 'text');
const COUNT = C('count', 'schedule.col.count', 'count', false, true);

export const SCHEDULES: ScheduleCategory[] = [
  {
    key: 'rooms', label: 'schedule.rooms', tables: ['space'],
    columns: [NUMBER, C('name', 'schedule.col.name', 'text'), LEVEL,
      // Net area at the wall faces (Revit's default); the centre-line area as an optional column
      C('area', 'schedule.col.area', 'area', true, true), C('gross_area', 'schedule.col.grossAreaCentreline', 'area', false, true),
      C('perimeter', 'schedule.col.perimeter', 'length', true, true), COUNT],
  },
  {
    key: 'doors', label: 'schedule.doors', tables: ['door'],
    columns: [NUMBER, LEVEL, C('host_id', 'schedule.col.host', 'text'), C('width', 'schedule.col.width', 'length'),
      C('height', 'schedule.col.height', 'length'), C('operation', 'schedule.col.operation', 'text'), MATERIAL, COUNT],
  },
  {
    key: 'windows', label: 'schedule.windows', tables: ['window'],
    columns: [NUMBER, LEVEL, C('host_id', 'schedule.col.host', 'text'), C('width', 'schedule.col.width', 'length'),
      C('height', 'schedule.col.height', 'length'), C('base_offset', 'schedule.col.sill', 'length'), MATERIAL, COUNT],
  },
  {
    key: 'walls', label: 'schedule.walls', tables: ['wall', 'structure_wall', 'curtain_wall'], groupBy: '',
    columns: [NUMBER, LEVEL, CATEGORY, MATERIAL, C('thickness', 'schedule.col.thickness', 'length'),
      C('length', 'schedule.col.length', 'length', true, true), C('qheight', 'schedule.col.height', 'length'),
      C('area', 'schedule.col.netArea', 'area', true, true), C('gross_area', 'schedule.col.grossArea', 'area', false, true),
      C('volume', 'schedule.col.volume', 'volume', true, true), COUNT],
  },
  {
    key: 'slabs', label: 'schedule.slabs', tables: ['slab', 'structure_slab', 'roof', 'ceiling', 'foundation'],
    columns: [NUMBER, LEVEL, CATEGORY, C('function', 'schedule.col.function', 'text'), MATERIAL,
      C('thickness', 'schedule.col.thickness', 'length'), C('area', 'schedule.col.area', 'area', true, true),
      C('perimeter', 'schedule.col.perimeter', 'length', false, true), C('volume', 'schedule.col.volume', 'volume', true, true), COUNT],
  },
  {
    key: 'columns', label: 'schedule.columns', tables: ['column', 'structure_column'], groupBy: 'size',
    columns: [NUMBER, LEVEL, CATEGORY, C('shape', 'schedule.col.shape', 'text'), C('size', 'schedule.col.size', 'text'),
      MATERIAL, C('qheight', 'schedule.col.height', 'length', true, true), C('volume', 'schedule.col.volume', 'volume', false, true),
      C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'framing', label: 'schedule.framing', tables: ['beam', 'brace'], groupBy: 'size',
    columns: [NUMBER, LEVEL, CATEGORY, C('size', 'schedule.col.size', 'text'), MATERIAL,
      C('length', 'schedule.col.length', 'length', true, true), C('count', 'schedule.col.count', 'count', true, true)],
  },
  ...MEP_SCHEDULES,
  {
    // Library components: count by family / variant, with the room they stand in
    key: 'furniture', label: 'schedule.furniture', tables: ['furniture'], groupBy: 'family_variant',
    columns: [C('family_variant', 'schedule.col.familyVariant', 'text'), C('room', 'schedule.col.room', 'text'), LEVEL, NUMBER,
      C('size', 'schedule.col.size', 'text'), C('count', 'schedule.col.count', 'count', true, true)],
  },
];

/** Section / size descriptor in project units ("300×600", "Ø150"). */
export function sizeLabel(el: CanonicalElement, unit: ProjectUnit): string {
  const f = (v: string | undefined) => {
    const n = parseFloat(v ?? '');
    if (!Number.isFinite(n)) return '';
    return unit === 'm' ? String(Math.round(n * 1000)) : String(Number(n.toFixed(unit === 'mm' ? 0 : 2)));
  };
  const sx = f(el.attrs.size_x), sy = f(el.attrs.size_y);
  if (el.attrs.shape === 'round' && sx) return `Ø${sx}`;
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

function rowValues(el: CanonicalElement, level: Level, q: ElementQuantities, unit: ProjectUnit, displayName: (table: string) => string, lang: DrawingLang): Record<string, string | number | undefined> {
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
    kind: a.kind ?? '',
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
  const mepValues = mepValueFn(unit, lang);
  const rooms = (levelId: string, elements: CanonicalElement[], context: CanonicalElement[]) => {
    let r = roomCache.get(levelId);
    if (!r) roomCache.set(levelId, r = levelRooms(elements, context));
    return r;
  };
  for (const { level, elements } of levels) {
    const context = [...elements, ...global];
    for (const el of elements) {
      if (!tables.has(el.tableName)) continue;
      const q = elementQuantities(el, level, allLevels, context);
      const values = rowValues(el, level, q, unit, displayName, lang);
      if (cat.filter && !cat.filter(el)) continue;
      if (el.tableName === 'furniture') Object.assign(values, furnitureValues(el, rooms(level.id, elements, context), lang));
      const mep = mepValues(el, level.id, context, values);
      if (mep) Object.assign(values, mep);
      rows.push({ sid: `${level.id}:${el.id}`, id: el.id, levelId: level.id, table: el.tableName, values });
    }
  }
  // Multi-storey elements in global/ count once, on their base level
  for (const el of global) {
    if (!tables.has(el.tableName) || !lowest || (cat.filter && !cat.filter(el))) continue;
    const level = allLevels.find(l => l.id === el.attrs.base_level_id) ?? lowest;
    const context = [...(levels.find(l => l.level.id === level.id)?.elements ?? []), ...global];
    const q = elementQuantities(el, level, allLevels, context);
    const values = rowValues(el, level, q, unit, displayName, lang);
    const mep = mepValues(el, level.id, context, values);
    if (mep) Object.assign(values, mep);
    rows.push({ sid: `global:${el.id}`, id: el.id, levelId: 'global', table: el.tableName, values });
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

/** Group rows collapsed to one row each (text shown when the group shares it, totals summed), as one group. */
export function collapseGroups(groups: RowGroup[], columns: ScheduleColumn[]): RowGroup[] {
  const rows: ScheduleRow[] = groups.filter(g => g.rows.length > 0).map(g => {
    const first = g.rows[0];
    const values: ScheduleRow['values'] = {};
    for (const c of columns) {
      if (c.total) { values[c.key] = g.totals[c.key]; continue; }
      const v = first.values[c.key];
      values[c.key] = g.rows.every(r => r.values[c.key] === v) ? v : undefined;
    }
    return { ...first, values, members: g.rows.map(r => ({ sid: r.sid, levelId: r.levelId })) };
  });
  return [{ key: '', rows, totals: totalsOf(rows, columns) }];
}

/**
 * The groups a schedule shows: sorted rows grouped by `groupBy`; when not
 * itemized, each group collapsed to one row (then sorted).
 */
export function scheduleGroups(rows: ScheduleRow[], columns: ScheduleColumn[], groupBy: string, sort: SortState, itemize = true): RowGroup[] {
  const groups = groupRows(sortRows(rows, sort), groupBy, columns);
  if (itemize || !groupBy) return groups;
  const [g] = collapseGroups(groups, columns);
  return [{ ...g, rows: sortRows(g.rows, sort) }];
}

/** Decimals for a column in `unit` (undefined = the kind's default). */
export function columnDigits(c: Pick<ScheduleColumn, 'digits'>, unit: ProjectUnit): number | undefined {
  return typeof c.digits === 'number' ? c.digits : c.digits?.[unit];
}

/** Cell text in project units (`digits` overrides the kind's decimals). */
export function formatCell(v: string | number | undefined, kind: ColumnKind, unit: ProjectUnit, digits?: number): string {
  if (v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (digits !== undefined) return kind === 'count' ? String(Number(v.toFixed(digits))) : v.toFixed(digits);
  switch (kind) {
    case 'count': return String(v);
    case 'length': return v.toFixed(unit === 'mm' ? 0 : unit === 'm' ? 3 : 2);
    case 'area': return v.toFixed(unit === 'mm' ? 0 : 2);
    case 'volume': return v.toFixed(unit === 'mm' ? 0 : 3);
    default: return String(v);
  }
}

export function unitSuffix(kind: ColumnKind, unit: ProjectUnit): string {
  if (kind === 'length') return unit;
  if (kind === 'area') return `${unit}²`;
  if (kind === 'volume') return `${unit}³`;
  return '';
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A number rounded to the column's decimals (6 when it has none), for CSV / XLSX. */
export function roundValue<T extends string | number | undefined>(v: T, c: ScheduleColumn, unit: ProjectUnit): T {
  return (typeof v === 'number' ? Number(v.toFixed(columnDigits(c, unit) ?? 6)) : v) as T;
}

/** CSV text: header, rows (numbers unformatted, rounded to the column's decimals or 6), group subtotals and a total line. */
export function scheduleCsv(groups: RowGroup[], columns: ScheduleColumn[], header: string[], totalLabel: string, unit: ProjectUnit = 'm'): string {
  const lines = [header.map(csvCell).join(',')];
  const cell = (v: string | number | undefined, c: ScheduleColumn) => (typeof v === 'number' ? String(roundValue(v, c, unit)) : csvCell(v ?? ''));
  for (const g of groups) {
    for (const r of g.rows) lines.push(columns.map(c => cell(r.values[c.key], c)).join(','));
    if (groups.length > 1) lines.push(columns.map((c, i) => (i === 0 ? csvCell(`${totalLabel}: ${g.key || '—'}`) : c.total ? cell(g.totals[c.key], c) : '')).join(','));
  }
  const all = groups.flatMap(g => g.rows);
  const grand = totalsOf(all, columns);
  lines.push(columns.map((c, i) => (i === 0 ? csvCell(totalLabel) : c.total ? cell(grand[c.key], c) : '')).join(','));
  return lines.join('\n') + '\n';
}
