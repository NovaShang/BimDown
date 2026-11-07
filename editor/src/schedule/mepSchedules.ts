/**
 * MEP engineering schedules: runs (aggregated by system and size), equipment
 * and terminals (tag, translated type, family / type, system, flow, load,
 * W×D×H size, mounting height), accessories (kind, system, DN / W×H size) and
 * circuits (panel by its tag). Sizes are named like the plan tags through
 * mep/sizes.ts (DN65, de110, Ø250, 400×300).
 */
import type { CanonicalElement, LineElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import type { ScheduleCategory, ScheduleColumn, ColumnKind } from './schedules.ts';
import { circuitsIn, type CircuitSummary } from '../mep/circuits.ts';
import { formatMepSize, fromMetres, sizeDisplayUnit, sizeToDisplay, toMetres } from '../mep/sizes.ts';
import { ACCESSORY_KIND_OPTIONS, EQUIPMENT_TYPE_OPTIONS, TERMINAL_TYPE_OPTIONS } from '../elements/_options.ts';
import { drawingLabel, type DrawingLang } from '../export/drawing/labels.ts';

type Digits = ScheduleColumn['digits'];
const C = (key: string, label: string, kind: ColumnKind, defaultOn = true, total = false, digits?: Digits): ScheduleColumn =>
  ({ key, label, kind, defaultOn, total, ...(digits !== undefined ? { digits } : {}) });

/** Run lengths to the centimetre (or the project unit's equivalent). */
const RUN_DIGITS: Digits = { m: 2, mm: 0, ft: 2, in: 1 };

const LEVEL = C('level', 'schedule.col.level', 'text');
const NUMBER = C('number', 'schedule.col.number', 'text');
const SYSTEM = C('system_type', 'schedule.col.system', 'text');
const FAMILY = C('family', 'schedule.col.family', 'text');
const FAMILY_TYPE = C('family_type', 'schedule.col.type', 'text');
const FLOW = (total: boolean) => C('flow', 'schedule.col.flowLs', 'count', true, total, 1);
const DIMS = C('dims', 'schedule.col.sizeWDH', 'text');

export const MEP_RUN_TABLES = ['duct', 'pipe', 'conduit', 'cable_tray'];

export const MEP_SCHEDULES: ScheduleCategory[] = [
  {
    // One row per system and size with the total length; tick "Itemize" for every segment
    key: 'mep', label: 'schedule.mep', tables: MEP_RUN_TABLES, groupBy: 'system_size', itemize: false,
    columns: [C('category', 'schedule.col.category', 'text'), SYSTEM, C('size', 'schedule.col.size', 'text'),
      C('system_size', 'schedule.col.systemSize', 'text', false), C('insulation', 'schedule.col.insulation', 'length'), LEVEL,
      C('number', 'schedule.col.number', 'text', false), C('length', 'schedule.col.length', 'length', true, true, RUN_DIGITS),
      C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    // One row per unit by tag (group by type from the toolbar)
    key: 'equipment', label: 'schedule.equipment', tables: ['equipment'], groupBy: '',
    columns: [NUMBER, C('device_type', 'schedule.col.equipmentType', 'text'), FAMILY, FAMILY_TYPE, SYSTEM, FLOW(false),
      C('load_kw', 'schedule.col.loadKw', 'count', true, true, 2), DIMS, LEVEL, C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    key: 'terminals', label: 'schedule.terminals', tables: ['terminal'], groupBy: 'device_type',
    columns: [NUMBER, C('device_type', 'schedule.col.terminalType', 'text'), FAMILY, FAMILY_TYPE, SYSTEM, FLOW(true),
      C('load_w', 'schedule.col.loadW', 'count', true, true, 0), DIMS, C('mounting', 'schedule.col.mountingHeight', 'length', true, false, RUN_DIGITS), LEVEL,
      C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    // Inline accessories (valves, dampers, strainers …); passive fittings are not listed
    key: 'accessories', label: 'schedule.accessories', tables: ['mep_node'], groupBy: 'kind',
    filter: el => !!(el.attrs.kind ?? '').trim(),
    columns: [C('kind', 'schedule.col.kind', 'text'), SYSTEM, C('size', 'schedule.col.size', 'text'),
      C('family', 'schedule.col.family', 'text', false), C('family_type', 'schedule.col.type', 'text', false),
      LEVEL, NUMBER, C('count', 'schedule.col.count', 'count', true, true)],
  },
  {
    // Electrical circuits with their connected load (sum of the devices' load)
    key: 'circuits', label: 'schedule.circuits', tables: ['circuit'], groupBy: 'panel',
    columns: [C('panel', 'schedule.col.panel', 'text'), NUMBER, C('name', 'schedule.col.name', 'text'), LEVEL,
      C('voltage', 'schedule.col.voltage', 'text'), C('rating', 'schedule.col.rating', 'text'),
      C('devices', 'schedule.col.devices', 'count', true, true), C('load_w', 'schedule.col.loadW', 'count', true, true)],
  },
];

const RUNS = new Set(MEP_RUN_TABLES);
const num = (v: string | undefined) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : undefined;
};

/** Enum value as its option label in `lang` (ahu → "AHU" / 空调机组); unknown values humanised. */
function optionLabel(options: { value: string; label: string }[] | undefined, value: string | undefined, lang: DrawingLang): string {
  if (!value) return '';
  const label = options?.find(o => o.value === value)?.label;
  if (label) return drawingLabel(lang, `option.${label}`);
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Run size label (DN65, de110, Ø250, 400×300) from size_x / size_y in project units. */
export function runSizeLabel(el: CanonicalElement, unit: ProjectUnit): string {
  const x = num(el.attrs.size_x), y = num(el.attrs.size_y);
  if (!x) return '';
  return formatMepSize(el.tableName, el.attrs.shape ?? '', toMetres(x, unit), y ? toMetres(y, unit) : 0, { material: el.attrs.material, unit });
}

/** Plan W × D × vertical H of a device in mm (inches for imperial projects). */
function deviceDims(el: CanonicalElement, unit: ProjectUnit): string {
  if (el.geometry !== 'point') return '';
  const p = el as PointElement;
  const h = num(p.attrs.height);
  const f = (v: number) => {
    const d = sizeToDisplay(v, unit);
    return String(sizeDisplayUnit(unit) === 'mm' ? Math.round(d) : d);
  };
  const parts = [p.width, p.height, ...(h ? [h] : [])].filter(v => v > 0).map(f);
  return parts.join('×');
}

/** The run an accessory sits on: a curve with an end at the node, else the nearest by kind. */
function accessoryHost(el: CanonicalElement, context: CanonicalElement[], unit: ProjectUnit): CanonicalElement | undefined {
  if (el.geometry !== 'point') return undefined;
  const at = (el as PointElement).position;
  const tol = fromMetres(0.005, unit);
  return context.find(c => {
    if (!RUNS.has(c.tableName) || (c.geometry !== 'line' && c.geometry !== 'spatial_line')) return false;
    const l = c as LineElement | SpatialLineElement;
    return Math.hypot(l.start.x - at.x, l.start.y - at.y) <= tol || Math.hypot(l.end.x - at.x, l.end.y - at.y) <= tol;
  });
}

/** Accessory body size: its own size_w / size_h, else the run it sits on. */
function accessorySize(el: CanonicalElement, context: CanonicalElement[], unit: ProjectUnit): string {
  const host = accessoryHost(el, context, unit);
  const table = host?.tableName ?? ((el.attrs.kind ?? '').includes('damper') ? 'duct' : 'pipe');
  const w = num(el.attrs.size_w);
  if (!w) return host ? runSizeLabel(host, unit) : '';
  const h = num(el.attrs.size_h);
  const shape = el.attrs.shape || host?.attrs.shape || (table === 'pipe' ? 'round' : '');
  return formatMepSize(table, shape, toMetres(w, unit), h ? toMetres(h, unit) : 0, { material: host?.attrs.material, unit });
}

/** A panel's name on schedules: its tag, else family / type, else its type label. */
export function panelLabel(panel: CanonicalElement | undefined, panelId: string, lang: DrawingLang): string {
  if (!panel) return panelId;
  const a = panel.attrs;
  return a.number || a.name || [a.family, a.type].filter(Boolean).join(' ')
    || optionLabel(EQUIPMENT_TYPE_OPTIONS, a.equipment_type, lang) || panelId;
}

/**
 * Per-row MEP values for `scheduleRows` (null for other tables). Keeps one
 * circuit summary per level between rows.
 */
export function mepValueFn(unit: ProjectUnit, lang: DrawingLang) {
  const circuitCache = new Map<string, Map<string, CircuitSummary>>();
  const circuits = (levelId: string, context: CanonicalElement[]) => {
    let c = circuitCache.get(levelId);
    if (!c) circuitCache.set(levelId, c = new Map(circuitsIn(new Map(context.map(e => [e.id, e]))).map(x => [x.id, x])));
    return c;
  };
  return (el: CanonicalElement, levelId: string, context: CanonicalElement[], base: Record<string, string | number | undefined>): Record<string, string | number | undefined> | null => {
    const a = el.attrs;
    if (RUNS.has(el.tableName)) {
      const size = runSizeLabel(el, unit);
      const system = (a.system_type ?? '').trim();
      return { size, system_size: `${system || String(base.category ?? '')} ${size}`.trim() };
    }
    if (el.tableName === 'equipment' || el.tableName === 'terminal') {
      const isEq = el.tableName === 'equipment';
      const load = num(a.load);
      return {
        device_type: optionLabel(isEq ? EQUIPMENT_TYPE_OPTIONS : TERMINAL_TYPE_OPTIONS, isEq ? a.equipment_type : a.terminal_type, lang),
        family: a.family ?? '',
        family_type: a.type ?? '',
        flow: num(a.flow),
        load_w: load,
        load_kw: load !== undefined ? load / 1000 : undefined,
        dims: deviceDims(el, unit),
        mounting: num(a.base_offset),
      };
    }
    if (el.tableName === 'mep_node') {
      return {
        kind: optionLabel(ACCESSORY_KIND_OPTIONS, a.kind, lang),
        size: accessorySize(el, context, unit),
        family: a.family ?? '',
        family_type: a.type ?? '',
      };
    }
    if (el.tableName === 'circuit') {
      const c = circuits(levelId, context).get(el.id);
      const panelId = c?.panelId ?? a.host_id ?? '';
      return {
        panel: panelLabel(context.find(e => e.id === panelId), panelId, lang),
        voltage: a.voltage ? `${a.voltage} V` : '',
        rating: a.rating ? `${a.rating} A` : '',
        devices: c?.devices.length ?? 0,
        load_w: Math.round(c?.load ?? 0),
      };
    }
    return null;
  };
}
