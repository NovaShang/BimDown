/**
 * Conversion state shared by the per-category converters: levels, the
 * BimDown elements produced so far (with level-scoped ids), what each IFC
 * product became, and the import notes / statistics for the report.
 */
import { ID_PREFIXES } from '../schema/prefixes.js';
import type { IfcModel } from './model.js';
import { str } from './model.js';
import type { WorldMesh } from './geometry.js';
import { r3 } from './math.js';

export interface Level {
  index: number;
  id: string;
  number: string;
  name: string;
  elevation: number;
}

export type Position2 = [number, number];
export type Position3 = [number, number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Position2 | Position3 }
  | { type: 'LineString'; coordinates: (Position2 | Position3)[] }
  | { type: 'Polygon'; coordinates: Position2[][] };

export type AttrValue = string | number | null | undefined;

/** One BimDown element (a CSV row plus, for tables that have one, a GeoJSON feature). */
export interface OutEl {
  table: string;
  id: string;
  /** Source IFC express id (0 for elements the importer adds, e.g. room separators). */
  src: number;
  /** Base level index. */
  level: number;
  /** Lives in global/ (spans more than one level above its base). */
  global?: boolean;
  attrs: Record<string, AttrValue>;
  /** GeoJSON feature properties besides `id` (base_offset, top_offset, arc, rotation, size). */
  props: Record<string, unknown>;
  geometry: Geometry | null;
}

/** Circular arc of a line element (BimDown `arc` = SVG semantics, sweep true = CCW in plan). */
export interface ArcInfo { center: { x: number; y: number }; radius: number; ccw: boolean; sweepRad: number }

export interface LineInfo {
  thickness: number;
  arc?: ArcInfo;
  zMin: number;
  zMax: number;
}

/** Vertical placement of a level-anchored element. */
export interface Span {
  baseOffset: number;
  topLevel: number;
  topOffset: number;
  global: boolean;
}

export class ImportContext {
  readonly model: IfcModel;
  meshes = new Map<number, WorldMesh>();
  levels: Level[] = [];
  /** IfcBuildingStorey express id → level index. */
  storeyLevel = new Map<number, number>();
  out: OutEl[] = [];
  /** Element type rows made so far (e.g. `railing_type:<IfcRailingType id>` → row id). */
  typeIds = new Map<string, string>();
  /** IFC product → BimDown elements made from it. */
  bySrc = new Map<number, OutEl[]>();
  /** Part → the aggregate it was imported with (curtain wall panels, stair flights' parent …). */
  consumed = new Map<number, number>();
  /** Why a product was not imported (first reason wins). */
  skipped = new Map<number, string>();
  notes: string[] = [];
  /** Boundary lines (walls, curtain walls, separators): plan thickness, arc and world z range. */
  lines = new Map<OutEl, LineInfo>();
  /** Tables the target format supports (furniture is optional). */
  tables: Set<string>;
  private counters = new Map<string, number>();

  constructor(model: IfcModel, tables: Set<string>) {
    this.model = model;
    this.tables = tables;
  }

  /** Create an element with the next id of its table. */
  add(table: string, src: number, level: number, attrs: Record<string, AttrValue>, geometry: Geometry | null, props: Record<string, unknown> = {}): OutEl {
    const n = (this.counters.get(table) ?? 0) + 1;
    this.counters.set(table, n);
    const el: OutEl = { table, id: `${ID_PREFIXES[table] ?? table}-${n}`, src, level, attrs, props, geometry };
    this.out.push(el);
    if (src) {
      const list = this.bySrc.get(src);
      if (list) list.push(el); else this.bySrc.set(src, [el]);
    }
    return el;
  }

  /** Record why a product was not imported. */
  skip(src: number, reason: string): void {
    if (!this.skipped.has(src)) this.skipped.set(src, reason);
  }

  /** A part handled together with its aggregate. */
  consume(part: number, whole: number): void {
    if (!this.consumed.has(part)) this.consumed.set(part, whole);
  }

  /** Remove an element that post-processing merged away. */
  remove(el: OutEl): void {
    const i = this.out.indexOf(el);
    if (i >= 0) this.out.splice(i, 1);
    const list = this.bySrc.get(el.src);
    if (list) {
      const j = list.indexOf(el);
      if (j >= 0) list.splice(j, 1);
    }
  }

  note(text: string): void {
    this.notes.push(text);
  }

  mesh(id: number): WorldMesh | null {
    return this.meshes.get(id) ?? null;
  }

  // ─── Levels ────────────────────────────────────────────────────────────────

  /**
   * Base level of a product: its storey (through spaces and aggregates),
   * else the highest level at or below `zMin`.
   */
  levelOf(productId: number, zMin?: number): number {
    let id: number | undefined = productId;
    for (let guard = 0; id && guard < 12; guard++) {
      const c = this.model.container.get(id);
      if (c !== undefined) {
        const lv = this.storeyLevel.get(c);
        if (lv !== undefined) return lv;
        id = c; // a space or zone: continue up
        continue;
      }
      const lv = this.storeyLevel.get(id);
      if (lv !== undefined) return lv;
      id = this.model.parent.get(id);
    }
    return this.levelAtZ(zMin ?? 0);
  }

  /**
   * Level of a horizontal MEP run at height `z`: its storey, unless the run
   * lies outside that storey's height band (below its floor, or at / above
   * the next level) — then the level its elevation falls in (Revit models
   * often host a ceiling-void duct on the storey above).
   */
  levelOfRun(productId: number, z: number): number {
    const lv = this.levelOf(productId, z);
    const floor = this.elevation(lv);
    const next = this.levels.filter(l => l.elevation > floor + 1e-6).reduce((m, l) => Math.min(m, l.elevation), Infinity);
    return z < floor - 0.05 || z >= next - 0.05 ? this.levelAtZ(z) : lv;
  }

  levelAtZ(z: number): number {
    let best = 0;
    for (const l of this.levels) if (l.elevation <= z + 0.05) best = l.index;
    return best;
  }

  elevation(level: number): number {
    return this.levels[level]?.elevation ?? 0;
  }

  /**
   * Vertical span of a level-anchored element from `zMin` to `zMax`: the top
   * is tied to the nearest level at or above the base (explicitly, so every
   * reader agrees), and elements reaching two or more levels up go to global/.
   */
  span(level: number, zMin: number, zMax: number): Span {
    const baseOffset = zMin - this.elevation(level);
    let top = level, bestD = Infinity;
    for (const l of this.levels) {
      if (l.index < level) continue;
      const d = Math.abs(l.elevation - zMax);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) < 1e-6 && l.elevation > this.elevation(top))) { bestD = d; top = l.index; }
    }
    // A wall that only reaches part-way to the level above keeps that level as top (negative offset).
    if (top === level && level + 1 < this.levels.length && zMax - this.elevation(level) > 1.5 && zMax <= this.elevation(level + 1) + 0.01) top = level + 1;
    return { baseOffset, topLevel: top, topOffset: zMax - this.elevation(top), global: top >= level + 2 };
  }

  /** CSV attrs + props for a span. */
  applySpan(level: number, attrs: Record<string, AttrValue>, props: Record<string, unknown>, span: Span): void {
    // global/ rows name their base level; level folders imply it.
    if (span.global) attrs.base_level_id = this.levels[level]?.id;
    attrs.top_level_id = this.levels[span.topLevel]?.id;
    if (Math.abs(span.baseOffset) >= 0.0005) props.base_offset = r3(span.baseOffset);
    if (Math.abs(span.topOffset) >= 0.0005) props.top_offset = r3(span.topOffset);
  }

  // ─── Names ─────────────────────────────────────────────────────────────────

  /** Display label of a product: its Name without a trailing Revit element id. */
  label(productId: number): string | undefined {
    const p = this.model.line(productId);
    const name = str(p?.Name);
    if (!name) return str(p?.ObjectType) ?? undefined;
    return name.replace(/:\d{3,}$/, '');
  }
}
