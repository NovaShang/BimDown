/**
 * Copy of bimdown-editor/editor/src/geometry/modelChecks.ts (verbatim; web/src/lib/shared-code-drift.test.ts).
 */
/**
 * Model checks shared by `bimdown build` / `validate` and the editor
 * (Warnings panel, properties): overlapping doors / windows / openings on
 * one host, walls overlapping each other, and numeric fields that must be
 * positive (thickness, widths…). Pure core on a flat,
 * unit-agnostic model; callers pass a tolerance in project units. The CLI
 * keeps a verbatim copy in bimdown-spec/cli/src/build/model-checks.ts
 * (web/src/lib/shared-code-drift.test.ts).
 */
interface P { x: number; y: number }

/** A door / window / wall opening on its host: centre `position` from the host start, `width` along it. */
export interface CheckInsert {
  id: string;
  /** Id scope (level directory). */
  scope: string;
  table: string;
  hostId: string;
  position: number;
  width: number;
  /** Sill above the host base and height; inserts stacked one over the other don't clash. */
  sill?: number;
  height?: number;
}

/** A straight wall (or structure wall) centre line. */
export interface CheckWall {
  id: string;
  scope: string;
  table: string;
  a: P;
  b: P;
  thickness: number;
  /** Absolute bottom / top; walls one above the other don't clash. */
  z0?: number;
  z1?: number;
}

export type ModelProblemCode = 'insert_overlap' | 'wall_overlap';

export interface ModelProblem {
  code: ModelProblemCode;
  scope: string;
  /** The elements involved (the pair). */
  ids: [string, string];
  tables: [string, string];
  /** insert_overlap: the shared host. */
  hostId?: string;
  /** Overlap length along the host / walls. */
  overlap: number;
  /** wall_overlap: middle of the overlap. */
  at?: P;
  message: string;
}

const fmt = (v: number) => v.toFixed(3);

/** Vertical ranges [a0, a1] and [b0, b1] overlap by more than `tol` (unknown ranges count as overlapping). */
function zOverlap(a0: number | undefined, a1: number | undefined, b0: number | undefined, b1: number | undefined, tol: number): boolean {
  if (a0 === undefined || a1 === undefined || b0 === undefined || b1 === undefined) return true;
  return Math.min(a1, b1) - Math.max(a0, b0) > tol;
}

/** Pairs of inserts on the same host whose spans along it overlap by more than `tol`. */
export function insertOverlaps(inserts: CheckInsert[], tol: number): ModelProblem[] {
  const out: ModelProblem[] = [];
  const byHost = new Map<string, CheckInsert[]>();
  for (const e of inserts) {
    if (!e.hostId || !Number.isFinite(e.position) || !Number.isFinite(e.width)) continue;
    const key = `${e.scope}\u0000${e.hostId}`;
    const list = byHost.get(key);
    if (list) list.push(e);
    else byHost.set(key, [e]);
  }
  for (const group of byHost.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.position - b.position);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const aLo = a.position - a.width / 2, aHi = a.position + a.width / 2;
        const bLo = b.position - b.width / 2, bHi = b.position + b.width / 2;
        const overlap = Math.min(aHi, bHi) - Math.max(aLo, bLo);
        if (overlap <= tol) continue;
        const aTop = a.sill !== undefined && a.height !== undefined ? a.sill + a.height : undefined;
        const bTop = b.sill !== undefined && b.height !== undefined ? b.sill + b.height : undefined;
        if (!zOverlap(a.sill, aTop, b.sill, bTop, tol)) continue;
        out.push({
          code: 'insert_overlap', scope: a.scope, ids: [a.id, b.id], tables: [a.table, b.table], hostId: a.hostId, overlap,
          message: `${a.id} and ${b.id} overlap on ${a.hostId} (${a.id}: ${fmt(aLo)}–${fmt(aHi)}m, ${b.id}: ${fmt(bLo)}–${fmt(bHi)}m)`,
        });
      }
    }
  }
  return out;
}

/** Sine of the largest angle (≈1.2°) between two walls still treated as parallel. */
const PARALLEL_SIN = 0.02;

/**
 * Pairs of walls of one scope that overlap (Revit "Highlighted walls
 * overlap"): parallel, one's centre line inside the other's thickness, and
 * running side by side for more than `minOverlap`.
 */
export function wallOverlaps(walls: CheckWall[], tol: number, minOverlap = tol * 10): ModelProblem[] {
  const out: ModelProblem[] = [];
  const items = walls
    .map(w => {
      const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
      const len = Math.hypot(dx, dy);
      return { w, len, ux: dx / len, uy: dy / len, minX: Math.min(w.a.x, w.b.x) - w.thickness, maxX: Math.max(w.a.x, w.b.x) + w.thickness, minY: Math.min(w.a.y, w.b.y) - w.thickness, maxY: Math.max(w.a.y, w.b.y) + w.thickness };
    })
    .filter(i => i.len > tol)
    .sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const B = items[j];
      if (B.minX > A.maxX) break;
      if (A.w.scope !== B.w.scope || B.minY > A.maxY || B.maxY < A.minY) continue;
      if (Math.abs(A.ux * B.uy - A.uy * B.ux) > PARALLEL_SIN) continue;
      // Centre-line offset, measured across A at B's ends
      const across = (p: P) => -(p.x - A.w.a.x) * A.uy + (p.y - A.w.a.y) * A.ux;
      const off = Math.max(Math.abs(across(B.w.a)), Math.abs(across(B.w.b)));
      if (off >= Math.max(A.w.thickness, B.w.thickness) / 2 - tol) continue;
      const along = (p: P) => (p.x - A.w.a.x) * A.ux + (p.y - A.w.a.y) * A.uy;
      const b0 = along(B.w.a), b1 = along(B.w.b);
      const lo = Math.max(0, Math.min(b0, b1)), hi = Math.min(A.len, Math.max(b0, b1));
      if (hi - lo <= minOverlap) continue;
      if (!zOverlap(A.w.z0, A.w.z1, B.w.z0, B.w.z1, tol)) continue;
      const m = (lo + hi) / 2;
      out.push({
        code: 'wall_overlap', scope: A.w.scope, ids: [A.w.id, B.w.id], tables: [A.w.table, B.w.table], overlap: hi - lo,
        at: { x: A.w.a.x + A.ux * m, y: A.w.a.y + A.uy * m },
        message: `${A.w.id} and ${B.w.id} overlap for ${fmt(hi - lo)}m — one wall inside the other; delete or shorten one (room boundaries and quantities count both)`,
      });
    }
  }
  return out;
}

/** Numeric fields that must be greater than 0 when set (an empty value inherits from the type). */
export const POSITIVE_FIELDS = new Set([
  'thickness', 'width', 'height', 'size_x', 'size_y', 'flange', 'web', 'step_count',
  'u_spacing', 'v_spacing', 'mullion_width', 'mullion_depth', 'frame_width',
  'baluster_spacing', 'baluster_size', 'top_rail_size', 'conductivity',
]);
/** Numeric fields that must not be negative. */
export const NON_NEGATIVE_FIELDS = new Set(['position', 'u_grid_count', 'v_grid_count', 'u_value', 'shgc', 'vt', 'load', 'rating', 'voltage', 'poles']);

/** 'positive' / 'non_negative' when `raw` breaks the field's sign rule, else null (empty / non-numeric: other checks). */
export function numericFieldError(field: string, raw: string | undefined): 'positive' | 'non_negative' | null {
  if (raw === undefined || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (POSITIVE_FIELDS.has(field) && !(v > 0)) return 'positive';
  if (NON_NEGATIVE_FIELDS.has(field) && v < 0) return 'non_negative';
  return null;
}
