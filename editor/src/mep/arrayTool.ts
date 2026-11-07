/**
 * Array placement for terminals (sprinkler heads, lights, diffusers): two
 * clicks span a rectangle, the selected template is laid out on a grid at
 * the toolbar spacing (equal spacing, half a bay from the edges). With
 * "Pipe" on (sprinklers), branch lines, a cross main and drops to every head
 * are routed too, so the grid comes out connected.
 */
import type { CanonicalElement, SpatialLineElement } from '../model/elements.ts';
import type { ToolContext } from '../tools/types.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from '../tools/levelUtil.ts';
import { generateId } from '../model/ids.ts';
import { reservedIds } from './reservedIds.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { getStarter, materializeStarter, starterBaseOffset, type EquipmentStarter } from '../elements/equipment_starters.ts';

export const SPACING_KEY = '__spacing';
export const ARRAY_PIPE_KEY = '__array_pipe';
const STARTER_KEY = '__starter_key';

export interface ArrayLayout { xs: number[]; ys: number[] }

/** Grid positions inside [x0,x1]×[y0,y1] at most `spacing` apart, half a bay from the edges. */
export function arrayLayout(x0: number, y0: number, x1: number, y1: number, spacing: number): ArrayLayout {
  const axis = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const n = Math.max(1, Math.ceil((hi - lo) / Math.max(spacing, 0.3) - 1e-9));
    const step = (hi - lo) / n;
    return Array.from({ length: n }, (_, i) => lo + step * (i + 0.5));
  };
  return { xs: axis(x0, x1), ys: axis(y0, y1) };
}

interface ArrayOpts {
  starter: EquipmentStarter;
  levelId: string;
  baseOffset: string;
  withPipe: boolean;
  /** Branch / main / drop pipe sizes and height above the heads. */
  pipe?: { branch: number; main: number; drop: number; rise: number; system: string };
}

/** Terminals (+ connectors) and, optionally, the pipework feeding them. */
export function buildArray(layout: ArrayLayout, opts: ArrayOpts, existingIds: Set<string>): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  const heads: { x: number; y: number; ref: string; z: number }[] = [];
  const port = opts.starter.ports[0];
  for (const y of layout.ys) {
    for (const x of layout.xs) {
      const els = materializeStarter(opts.starter, { x, y }, opts.levelId, existingIds, undefined, opts.baseOffset);
      out.push(...els);
      const host = els[0];
      if (port) heads.push({ x, y, ref: `${host.id}:${port.name}`, z: (parseFloat(host.attrs.base_offset || '0') || 0) + port.offset[2] });
    }
  }
  if (!opts.withPipe || !port || !opts.pipe || heads.length === 0) return out;
  const p = opts.pipe;
  const zPipe = Math.max(...heads.map(h => h.z)) + p.rise;
  const pipeEl = (a: { x: number; y: number }, za: number, b: { x: number; y: number }, zb: number, size: number, to?: string): SpatialLineElement => {
    const id = generateId('pipe', existingIds);
    existingIds.add(id);
    const attrs: Record<string, string> = {
      ...defaultAttrs('pipe', opts.levelId), id, shape: 'round', size_x: String(size), size_y: String(size),
      system_type: p.system, start_z: String(za), end_z: String(zb),
    };
    if (to) attrs.to = to;
    return { id, tableName: 'pipe', discipline: 'mep', geometry: 'spatial_line', start: a, end: b, startZ: za, endZ: zb, strokeWidth: size, attrs };
  };
  const step = layout.xs.length > 1 ? layout.xs[1] - layout.xs[0] : 3;
  const xMain = layout.xs[0] - step / 2;
  // Drops: branch height down to each head's inlet.
  for (const h of heads) out.push(pipeEl({ x: h.x, y: h.y }, zPipe, { x: h.x, y: h.y }, h.z, p.drop, h.ref));
  // Branch lines along x, split at every head (tees come from the bonding pass).
  for (const y of layout.ys) {
    const xs = [xMain, ...layout.xs];
    for (let i = 0; i + 1 < xs.length; i++) out.push(pipeEl({ x: xs[i], y }, zPipe, { x: xs[i + 1], y }, zPipe, p.branch));
  }
  // Cross main along y, with a feed stub past the first branch.
  const ys = [layout.ys[0] - Math.min(1, step / 2), ...layout.ys];
  for (let i = 0; i + 1 < ys.length; i++) out.push(pipeEl({ x: xMain, y: ys[i] }, zPipe, { x: xMain, y: ys[i + 1] }, zPipe, p.main));
  return out;
}

export function arrayPointerDown(ctx: ToolContext, e: React.PointerEvent): void {
  if (e.button !== 0) return;
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return;
  const state = ctx.getState();
  const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
  const pt = snap.point;
  const points = state.drawingState?.points ?? [];
  if (points.length === 0) {
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [pt], cursor: pt } });
    return;
  }
  const da = state.drawingAttrs;
  const starter = getStarter(da[STARTER_KEY]) ?? getStarter('sprinkler_pendent');
  if (!starter) return;
  const spacing = parseFloat(da[SPACING_KEY] || '3') || 3;
  const layout = arrayLayout(points[0].x, points[0].y, pt.x, pt.y, spacing);
  const ids = reservedIds(state.document?.elements);
  const isSprinkler = starter.type_enum === 'sprinkler_head';
  const withPipe = isSprinkler && da[ARRAY_PIPE_KEY] !== 'false';
  const elements = buildArray(layout, {
    starter, levelId: resolveNextLevelId(state), baseOffset: starterBaseOffset(starter, da.base_offset), withPipe,
    pipe: { branch: 0.032, main: 0.05, drop: 0.025, rise: 0.35, system: 'FP' },
  }, ids);
  ctx.dispatch({ type: 'CREATE_ELEMENTS', elements, description: `Array ${layout.xs.length}×${layout.ys.length}`, selectPrimary: false });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  ctx.setSnap(null);
}

export function arrayPointerMove(ctx: ToolContext, e: React.PointerEvent): void {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return;
  const state = ctx.getState();
  const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: state.drawingState?.points ?? [], cursor: snap.point } });
  ctx.setSnap(snap);
}
