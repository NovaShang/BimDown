/**
 * Stair elements: building a placed stair (stair + stair_run + stair_landing +
 * stair railings) from a layout, and keeping a stair's parts consistent after
 * edits (riser rule, landing heights; spec stair.yaml).
 */
import type { CanonicalElement, LineElement, PolygonElement, SpatialLineElement } from './elements.ts';
import { generateId } from './ids.ts';
import { defaultAttrs } from './defaults.ts';
import type { Level } from '../types.ts';
import { arcHint, assembleStair, hostRefOf, planStairZ, type RailSide, type RunArc, type StairLayout } from '../geometry/stair.ts';
import type { ArcParams } from '../geometry/arc.ts';

/** Editor arc params of a curved run. */
function arcParams(a: RunArc | undefined): { arc?: ArcParams } {
  if (!a) return {};
  const h = arcHint(a);
  return { arc: { rx: h.radius, ry: h.radius, rotation: 0, largeArc: h.large_arc, sweep: h.sweep } };
}

export type StairRailingsOption = 'both' | 'left' | 'right' | 'none';

/** Drawing-bar option of the stair tool: automatic railings (UI-only, never stored). */
export const STAIR_RAILINGS_KEY = '__railings';

/** Drawing-bar option of the stair tool: how L / U stairs turn, 'landing' (default) or 'winders' (UI-only). */
export const STAIR_TURN_KEY = '__turn';

/** Drawing-bar option of stair by sketch: 'boundary' (default) or 'riser' (UI-only). */
export const SKETCH_MODE_KEY = '__sketch_mode';

export const STAIR_PART_TABLES = new Set(['stair_run', 'stair_landing']);

export function railingSides(option: string | undefined): RailSide[] {
  switch (option) {
    case 'none': return [];
    case 'left': return ['left'];
    case 'right': return ['right'];
    default: return ['left', 'right'];
  }
}

/** A stair railing: CSV-only (no geometry), its path derived from the stair. */
export function stairRailingElement(id: string, stairId: string, side: RailSide, levelId: string, attrs: Record<string, string> = {}): LineElement {
  return {
    id,
    tableName: 'railing',
    discipline: 'architecture',
    geometry: 'line',
    start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
    strokeWidth: 0.05,
    hostId: stairId,
    attrs: {
      ...defaultAttrs('railing', levelId),
      height: '1.0',
      ...attrs,
      id, host_id: stairId, side,
    },
  };
}

export interface StairPlacement {
  layout: StairLayout;
  existingIds: Iterable<string>;
  levelId: string;
  /** Stair attrs (drawing attrs merged over defaults); UI-only `__` keys are dropped. */
  attrs: Record<string, string>;
  width: number;
  railings: StairRailingsOption | string | undefined;
}

/** The elements of a newly placed stair, parts hosted on it (one undo step). */
export function stairElements(p: StairPlacement): CanonicalElement[] {
  const ids = new Set(p.existingIds);
  const take = (table: string) => {
    const id = generateId(table, ids);
    ids.add(id);
    return id;
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.attrs)) if (!k.startsWith('__')) clean[k] = v;
  const out: CanonicalElement[] = [];
  const [first, ...rest] = p.layout.runs;
  const stairId = take('stair');
  const stair: SpatialLineElement = {
    id: stairId, tableName: 'stair', discipline: 'architecture', geometry: 'spatial_line',
    start: first.start, end: first.end, startZ: first.startZ, endZ: first.endZ, strokeWidth: first.width ?? p.width,
    ...arcParams(first.arc),
    attrs: {
      ...clean, id: stairId,
      start_z: String(first.startZ), end_z: String(first.endZ),
      width: String(first.width ?? p.width), step_count: String(first.steps),
    },
  };
  out.push(stair);
  rest.forEach((r, i) => {
    const landing = p.layout.landings[i];
    if (landing) {
      const lid = take('stair_landing');
      const el: PolygonElement = {
        id: lid, tableName: 'stair_landing', discipline: 'architecture', geometry: 'polygon',
        vertices: landing.vertices, hostId: stairId,
        attrs: {
          ...defaultAttrs('stair_landing', p.levelId), id: lid, host_id: stairId,
          base_offset: String(landing.top), material: clean.material || 'concrete',
          ...(landing.steps ? { step_count: String(landing.steps) } : {}),
        },
      };
      out.push(el);
    }
    const rid = take('stair_run');
    const run: SpatialLineElement = {
      id: rid, tableName: 'stair_run', discipline: 'architecture', geometry: 'spatial_line',
      start: r.start, end: r.end, startZ: r.startZ, endZ: r.endZ, strokeWidth: r.width ?? p.width, hostId: stairId,
      ...arcParams(r.arc),
      attrs: {
        ...defaultAttrs('stair_run', p.levelId), id: rid, host_id: stairId,
        start_z: String(r.startZ), end_z: String(r.endZ),
        width: String(r.width ?? p.width), step_count: String(r.steps),
        ...(clean.material ? { material: clean.material } : {}),
      },
    };
    out.push(run);
  });
  for (const side of railingSides(p.railings)) {
    out.push(stairRailingElement(take('railing'), stairId, side, p.levelId));
  }
  return out;
}

const num = (s: string | undefined, fallback: number) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Stair ids affected by a change of these elements (a stair, or the host of a part). */
export function stairsTouchedBy(els: Iterable<CanonicalElement | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const el of els) {
    if (!el) continue;
    if (el.tableName === 'stair') out.add(el.id);
    else if (STAIR_PART_TABLES.has(el.tableName) && hostRefOf(el)) out.add(hostRefOf(el));
  }
  return out;
}

/**
 * Re-apply the riser rule to each stair in `stairIds` (in `next`, mutated):
 * runs share one riser between the stair's base (base_offset) and its top
 * (top level + top offset, else the current top), landings sit at the top of
 * the run arriving on them. Returns the ids of the elements that changed.
 */
export function applyStairConsistency(
  next: Map<string, CanonicalElement>,
  stairIds: Iterable<string>,
  levels: readonly Level[],
  levelId: string,
): string[] {
  const changed: string[] = [];
  const all = [...next.values()];
  for (const sid of stairIds) {
    const stair = next.get(sid);
    if (!stair || stair.tableName !== 'stair') continue;
    const children = all.filter(c => STAIR_PART_TABLES.has(c.tableName) && hostRefOf(c) === sid).map(c => next.get(c.id) ?? c);
    const asm = assembleStair(stair, children);
    if (asm.runs.length === 0) continue;
    const curBase = Math.min(asm.runs[0].startZ, asm.runs[0].endZ);
    const curTop = Math.max(...asm.runs.map(r => Math.max(r.startZ, r.endZ)));
    const baseZ = num(stair.attrs.base_offset, curBase);
    let topZ = curTop;
    const top = stair.attrs.top_level_id ? levels.find(l => l.id === stair.attrs.top_level_id) : undefined;
    const here = levels.find(l => l.id === levelId);
    if (top && here) {
      const t = top.elevation - here.elevation + num(stair.attrs.top_offset, 0);
      if (t > baseZ + 1e-6) topZ = t;
    }
    if (topZ <= baseZ + 1e-6) topZ = curTop > baseZ + 1e-6 ? curTop : baseZ + 3;
    const plan = planStairZ(asm, baseZ, topZ);
    // An overall stair axis (not a flight) spans the whole rise.
    if (!asm.ownIsRun && stair.geometry === 'spatial_line') plan.runs.set(stair.id, { startZ: baseZ, endZ: topZ });
    for (const [id, z] of plan.runs) {
      const el = next.get(id);
      if (!el || el.geometry !== 'spatial_line') continue;
      const sp = el as SpatialLineElement;
      // Runs drawn top → bottom keep their direction.
      const down = sp.endZ < sp.startZ;
      const startZ = down ? z.endZ : z.startZ, endZ = down ? z.startZ : z.endZ;
      if (Math.abs(sp.startZ - startZ) < 1e-6 && Math.abs(sp.endZ - endZ) < 1e-6
        && num(sp.attrs.start_z, NaN) === startZ && num(sp.attrs.end_z, NaN) === endZ) continue;
      next.set(id, { ...sp, startZ, endZ, attrs: { ...sp.attrs, start_z: String(startZ), end_z: String(endZ) } });
      changed.push(id);
    }
    for (const [id, top] of plan.landings) {
      const el = next.get(id);
      if (!el) continue;
      if (Math.abs(num(el.attrs.base_offset, NaN) - top) < 1e-6) continue;
      next.set(id, { ...el, attrs: { ...el.attrs, base_offset: String(top) } });
      changed.push(id);
    }
  }
  return changed;
}
