/**
 * Auto-numbering (marks): `number` = prefix + sequence, per category.
 *
 *   structure   KZ columns, KL frame beams (into columns at both ends),
 *               L secondary beams (steel: GZ columns, GL frame beams, GCL
 *               secondary beams), ZC braces, Q walls, foundations by kind
 *               (J pad, TJ strip, FB raft, CT pile cap, ZH pile). Elements of
 *               one type (or one section / size when untyped) share a mark,
 *               as structural drawings label a design type (KZ1, KL2).
 *   MEP         equipment per instance by kind: AHU-1, VAV-1, P-1, LP-1 …;
 *               air terminals per instance: SD-1 supply, RG-1 return, EG-1 exhaust
 *   doors       D + level number + two digits (D101, D102), per instance;
 *   windows     W101 …; rooms 101, 102 … per level.
 *
 * Prefixes come from project_metadata.json `numbering` (key = table, or
 * table.kind for foundations / equipment / beams: foundation.pile,
 * equipment.ahu, beam.secondary), else the defaults below.
 */
import type { CanonicalElement, Point } from './elements.ts';
import type { Level } from '../types.ts';
import { typeOfElement, type TypeCatalog } from './types/catalog.ts';
import { elementTypeSig } from '../export/ifc/typeObjects.ts';
import { foundationKind } from '../elements/foundation.tsx';
import { COLUMN_TABLES, columnFootprint, insideFootprint, type ColumnFootprint } from '../elements/_framing.ts';

export type NumberingConfig = Record<string, string>;

export const DEFAULT_PREFIXES: NumberingConfig = {
  structure_column: 'KZ', beam: 'KL', 'beam.secondary': 'L', brace: 'ZC', structure_wall: 'Q',
  'foundation.pad': 'J', 'foundation.strip': 'TJ', 'foundation.raft': 'FB', 'foundation.pile_cap': 'CT', 'foundation.pile': 'ZH',
  'equipment.ahu': 'AHU-', 'equipment.fcu': 'FCU-', 'equipment.vav': 'VAV-', 'equipment.chiller': 'CH-', 'equipment.boiler': 'B-',
  'equipment.cooling_tower': 'CT-', 'equipment.fan': 'F-', 'equipment.pump': 'P-', 'equipment.transformer': 'TR-',
  'equipment.panelboard': 'LP-', 'equipment.generator': 'G-', 'equipment.water_heater': 'WH-', 'equipment.tank': 'T-',
  'equipment.other': 'EQ-', door: 'D', window: 'W', space: '',
  'structure_column.steel': 'GZ', 'beam.steel': 'GL', 'beam.steel_secondary': 'GCL',
  'terminal.supply_air_diffuser': 'SD-', 'terminal.return_air_grille': 'RG-', 'terminal.exhaust_air_grille': 'EG-',
};

/** Air terminal kinds that get a mark (diffuser / grille schedules). */
const NUMBERED_TERMINALS = new Set(['supply_air_diffuser', 'return_air_grille', 'exhaust_air_grille']);
const STEEL_SHAPES = new Set(['i_shape', 'c_shape', 'l_shape', 't_shape', 'cross', 'rect_hollow', 'round_hollow', 'open_web']);

/** A steel member: steel material, or a rolled / hollow section with no material given. */
function isSteel(el: CanonicalElement): boolean {
  const m = (el.attrs.material ?? '').trim();
  return m ? m === 'steel' : STEEL_SHAPES.has((el.attrs.shape ?? '').trim());
}

/** Tables whose marks are per design type (same type → same mark). */
const BY_TYPE = new Set(['structure_column', 'beam', 'brace', 'structure_wall', 'foundation']);
/** Tables numbered per level (level number + two digits). */
const BY_LEVEL = new Set(['door', 'window', 'space']);

export const NUMBERED_TABLES = new Set([...BY_TYPE, ...BY_LEVEL, 'equipment', 'terminal']);

/** Whether a beam frames into a column at both ends (a frame beam, KL) or not (a secondary beam, L). */
function isFrameBeam(el: CanonicalElement, columns: ColumnFootprint[]): boolean {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return true;
  if (el.attrs.beam_system_id) return false;
  if (columns.length === 0) return true;
  const hit = (p: Point) => columns.some(c => insideFootprint(c, p, 0.05));
  return hit(el.start) && hit(el.end);
}

/** Numbering key of an element: table, or table.kind. */
export function numberingKey(el: CanonicalElement, columns: ColumnFootprint[] = []): string | null {
  const t = el.tableName;
  if (!NUMBERED_TABLES.has(t)) return null;
  if (t === 'foundation') return `foundation.${foundationKind(el)}`;
  if (t === 'equipment') return `equipment.${el.attrs.equipment_type || 'other'}`;
  if (t === 'terminal') return NUMBERED_TERMINALS.has(el.attrs.terminal_type) ? `terminal.${el.attrs.terminal_type}` : null;
  if (t === 'beam') {
    const frame = isFrameBeam(el, columns);
    if (isSteel(el)) return frame ? 'beam.steel' : 'beam.steel_secondary';
    return frame ? 'beam' : 'beam.secondary';
  }
  if (t === 'structure_column' && isSteel(el)) return 'structure_column.steel';
  return t;
}

export function prefixFor(key: string, cfg: NumberingConfig | undefined): string {
  return cfg?.[key] ?? DEFAULT_PREFIXES[key] ?? DEFAULT_PREFIXES[key.split('.')[0]] ?? '';
}

/** Sequence number of `n` under `prefix` (KZ12 → 12), or NaN. */
function seqOf(n: string, prefix: string): number {
  if (!n.startsWith(prefix)) return NaN;
  const rest = n.slice(prefix.length);
  return /^\d+$/.test(rest) ? parseInt(rest, 10) : NaN;
}

/** Level-based base number: level number × 100 (L1 → 100, L2 → 200); basement B1 → 0 … */
function levelBase(level: Level | undefined): number {
  const n = parseInt(level?.number ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n * 100 : 0;
}

export interface NumberingContext {
  config?: NumberingConfig;
  types?: TypeCatalog;
  /** The level the elements are on (doors / windows / rooms are numbered per level). */
  level?: Level;
  upm?: number;
  /** Column footprints of the level (frame vs secondary beams). */
  columns?: ColumnFootprint[];
}

/** Design-type key of a structural element (shared mark). */
function designKey(el: CanonicalElement, ctx: NumberingContext): string {
  const t = typeOfElement(el, ctx.types);
  if (t) return `type:${t.id}`;
  return elementTypeSig(el, ctx.types, ctx.upm ?? 1)?.key ?? el.id;
}

/**
 * Numbers for `targets` (id → number), given every element that already
 * holds a number (`existing`, all levels for project-wide marks). By-type
 * categories reuse the mark of an existing element of the same type; the
 * rest take the next free sequence after the highest in use.
 */
export function assignNumbers(
  targets: readonly CanonicalElement[],
  existing: readonly CanonicalElement[],
  ctx: NumberingContext = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const columns = ctx.columns ?? [];
  const used = new Map<string, Set<string>>();          // prefix → numbers in use
  const typeMark = new Map<string, string>();           // key|design → mark
  const targetIds = new Set(targets.map(t => t.id));
  const keyCache = new Map<CanonicalElement, string | null>();
  const keyOf = (el: CanonicalElement) => {
    if (!keyCache.has(el)) keyCache.set(el, numberingKey(el, columns));
    return keyCache.get(el)!;
  };
  for (const el of existing) {
    const n = (el.attrs.number ?? '').trim();
    const key = keyOf(el);
    if (!n || !key || targetIds.has(el.id)) continue;
    const prefix = prefixFor(key, ctx.config);
    let set = used.get(prefix);
    if (!set) used.set(prefix, set = new Set());
    set.add(n);
    if (BY_TYPE.has(el.tableName)) {
      const dk = `${key}|${designKey(el, ctx)}`;
      if (!typeMark.has(dk)) typeMark.set(dk, n);
    }
  }
  const next = (prefix: string, base = 0) => {
    let set = used.get(prefix);
    if (!set) used.set(prefix, set = new Set());
    let max = base;
    for (const n of set) {
      const s = seqOf(n, prefix);
      if (Number.isFinite(s) && s > max && (base === 0 || s < base + 100)) max = s;
    }
    const v = `${prefix}${max + 1}`;
    set.add(v);
    return v;
  };
  for (const el of targets) {
    const key = keyOf(el);
    if (!key) continue;
    const prefix = prefixFor(key, ctx.config);
    if (BY_TYPE.has(el.tableName)) {
      const dk = `${key}|${designKey(el, ctx)}`;
      const mark = typeMark.get(dk) ?? next(prefix);
      typeMark.set(dk, mark);
      out.set(el.id, mark);
    } else if (BY_LEVEL.has(el.tableName)) {
      out.set(el.id, next(prefix, levelBase(ctx.level)));
    } else {
      out.set(el.id, next(prefix));
    }
  }
  return out;
}

/** Column footprints among `elements` (for frame / secondary beam keys). */
export function columnFootprintsOf(elements: Iterable<CanonicalElement>): ColumnFootprint[] {
  const out: ColumnFootprint[] = [];
  for (const el of elements) {
    if (!(COLUMN_TABLES as readonly string[]).includes(el.tableName)) continue;
    const fp = columnFootprint(el);
    if (fp) out.push(fp);
  }
  return out;
}

/** Sort for renumbering: by level-plan position, bottom-left first (rows by Y, then X). */
export function planOrder(a: CanonicalElement, b: CanonicalElement): number {
  const pa = anchor(a), pb = anchor(b);
  if (Math.abs(pa.y - pb.y) > 0.5) return pa.y - pb.y;
  return pa.x - pb.x;
}

function anchor(el: CanonicalElement): Point {
  if (el.geometry === 'point') return el.position;
  if (el.geometry === 'polygon') {
    const n = el.vertices.length || 1;
    return { x: el.vertices.reduce((s, p) => s + p.x, 0) / n, y: el.vertices.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
}
