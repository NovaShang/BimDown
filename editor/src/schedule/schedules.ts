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
}

export interface ScheduleCategory {
  key: string;
  label: string;
  tables: string[];
  columns: ScheduleColumn[];
  /** Initial group-by column ('' = none). */
  groupBy?: string;
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
  {
    key: 'mep', label: 'schedule.mep', tables: ['duct', 'pipe', 'conduit', 'cable_tray'], groupBy: 'system_type',
    columns: [CATEGORY, C('system_type', 'schedule.col.system', 'text'), C('size', 'schedule.col.size', 'text'), LEVEL,
      NUMBER, C('length', 'schedule.col.length', 'length', true, true), C('count', 'schedule.col.count', 'count', false, true)],
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
  const sx = f(el.attrs.size_x), sy = f(el.attrs.size_y);
  if (el.attrs.shape === 'round' && sx) return `Ø${sx}`;
  if (sx && sy) return `${sx}×${sy}`;
  return sx;
}

function rowValues(el: CanonicalElement, level: Level, q: ElementQuantities, unit: ProjectUnit, displayName: (table: string) => string): Record<string, string | number | undefined> {
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
    operation: a.operation ?? '',
    thickness: num(a.thickness),
    function: a.function ?? '',
    shape: a.shape ?? '',
    size: sizeLabel(el, unit),
    system_type: a.system_type ?? '',
    type: a.equipment_type || a.terminal_type || a.type || a.family || '',
    length: q.length,
    qheight: q.height,
    area: q.area,
    gross_area: q.gross_area,
    volume: q.volume,
    perimeter: q.perimeter,
    count: 1,
  };
}

/** All rows of a schedule across every level. */
export function scheduleRows(
  cat: ScheduleCategory, project: ProjectData, unit: ProjectUnit,
  displayName: (table: string) => string,
  liveLevel?: string, live?: Map<string, CanonicalElement>,
): ScheduleRow[] {
  const { levels, global } = collectLevels(project, liveLevel, live);
  const allLevels = levels.map(l => l.level);
  const tables = new Set(cat.tables);
  const rows: ScheduleRow[] = [];
  const lowest = allLevels[0];
  for (const { level, elements } of levels) {
    const context = [...elements, ...global];
    for (const el of elements) {
      if (!tables.has(el.tableName)) continue;
      const q = elementQuantities(el, level, allLevels, context);
      rows.push({ sid: `${level.id}:${el.id}`, id: el.id, levelId: level.id, table: el.tableName, values: rowValues(el, level, q, unit, displayName) });
    }
  }
  // Multi-storey elements in global/ count once, on their base level
  for (const el of global) {
    if (!tables.has(el.tableName) || !lowest) continue;
    const level = allLevels.find(l => l.id === el.attrs.base_level_id) ?? lowest;
    const context = [...(levels.find(l => l.level.id === level.id)?.elements ?? []), ...global];
    const q = elementQuantities(el, level, allLevels, context);
    rows.push({ sid: `global:${el.id}`, id: el.id, levelId: 'global', table: el.tableName, values: rowValues(el, level, q, unit, displayName) });
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
