import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { pointSizeAttrsForTable } from '../model/tableRegistry.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import { getStarter, materializeStarter } from '../elements/equipment_starters.ts';
import { getElementModule } from '../elements/registry.ts';
import { accessoryPointerDown } from '../mep/accessoryTool.ts';
import { arrayPointerDown, arrayPointerMove } from '../mep/arrayTool.ts';
import { parseTypedLength, typedKey } from './typedInput.ts';
import type { Point } from '../model/elements.ts';

/**
 * Typed placement: with the cursor on a reference (snapped: a column
 * centre, a grid crossing …) type ΔX, Tab, ΔY, Enter — the element lands at
 * that offset from the reference (e.g. piles at ±0.75 from a column centre).
 */
export function typedOffsetPoint(anchor: Point, typed: { length: string; angle: string }, unit: Parameters<typeof parseTypedLength>[1]): Point {
  return { x: anchor.x + (parseTypedLength(typed.length, unit) ?? 0), y: anchor.y + (parseTypedLength(typed.angle, unit) ?? 0) };
}

/** A module's own place tool (e.g. library furniture), if it declares one. */
function moduleTool(ctx: ToolContext): ToolHandler | undefined {
  const target = ctx.getState().drawingTarget;
  return target ? getElementModule(target.tableName)?.placeTool : undefined;
}

/** MEP placements with their own gesture: inline accessories, terminal arrays. */
function mepDelegate(target: { tableName: string; variantId?: string } | null): 'accessory' | 'array' | null {
  if (target?.tableName === 'mep_node') return 'accessory';
  if (target?.tableName === 'terminal' && target.variantId === 'array') return 'array';
  return null;
}

export const drawPointTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    const custom = moduleTool(ctx);
    if (custom) return custom.onPointerDown?.(ctx, e);
    if (e.button !== 0) return;
    const mep = mepDelegate(ctx.getState().drawingTarget);
    if (mep === 'accessory') { accessoryPointerDown(ctx, e); return; }
    if (mep === 'array') { arrayPointerDown(ctx, e); return; }

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    placePointAt(ctx, snap.point);
  },

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (moduleTool(ctx) || mepDelegate(ctx.getState().drawingTarget)) return false;
    const state = ctx.getState();
    const ds = state.drawingState;
    // Offsets are often negative: '-' opens a value here (elsewhere it zooms out).
    const res = !ds?.typed && e.key === '-' && !e.ctrlKey && !e.metaKey && !e.altKey
      ? { handled: true, typed: { length: '-', angle: '', field: 'length' as const }, commit: false }
      : typedKey(e, ds?.typed);
    if (!res.handled) return false;
    const anchor = ds?.typed ? ds.points[0] : ds?.cursor;
    if (!anchor) return false;
    if (res.commit && res.typed) {
      placePointAt(ctx, typedOffsetPoint(anchor, res.typed, getProjectUnits(state)));
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: ds?.cursor ?? anchor } });
      return true;
    }
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: res.typed ? [anchor] : [], cursor: ds?.cursor ?? anchor, typed: res.typed } });
    return true;
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const custom = moduleTool(ctx);
    if (custom) return custom.onPointerMove?.(ctx, e);
    if (mepDelegate(ctx.getState().drawingTarget) === 'array') { arrayPointerMove(ctx, e); return; }
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;
    // While an offset is being typed the reference stays put.
    const ds = state.drawingState;
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: ds?.typed ? { ...ds, cursor: pt } : { points: [], cursor: pt },
    });
    ctx.setSnap(snap);
  },
};

/** Place the drawing target at `pt` (starter equipment, or one point element). */
function placePointAt(ctx: ToolContext, pt: Point) {
  const state = ctx.getState();
  const target = state.drawingTarget;
  if (!target) return;

  const da = state.drawingAttrs;

  // Starter template: when the user has picked a kind from the equipment /
  // terminal template dropdown, materialize the host + its connector rows
  // as a single CREATE_ELEMENTS dispatch (one undo entry).
  const starter = getStarter(da[STARTER_KEY_ATTR]);
  if (starter && (target.tableName === 'equipment' || target.tableName === 'terminal')) {
    const existing = new Set(state.document?.elements.keys() ?? []);
    const rotationOverride = da.rotation !== undefined && da.rotation !== ''
      ? parseFloat(da.rotation) || 0
      : undefined;
    const levelId = resolveNextLevelId(state);
    const elements = materializeStarter(starter, pt, levelId, existing, rotationOverride, da.base_offset);
    ctx.dispatch({
      type: 'CREATE_ELEMENTS',
      elements,
      description: `Place ${starter.label_en}`,
    });
    ctx.setSnap(null);
    return;
  }

  const baseDefaults = defaultAttrs(target.tableName, resolveNextLevelId(state));
  const vDefaults = variantDefaults(target.tableName, target.variantId);
  const mergedAttrs = { ...baseDefaults, ...vDefaults, ...da };
  // Strip the UI-only starter sentinel.
  delete mergedAttrs[STARTER_KEY_ATTR];

  // Plan size attrs: size_x/size_y, or width/length for foundation pads.
  const [sxKey, syKey] = pointSizeAttrsForTable(target.tableName);
  const w = parseFloat(mergedAttrs[sxKey] || '0.3') || 0.3;
  const h = parseFloat(mergedAttrs[syKey] || '') || w;

  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId(target.tableName, existingIds);

  // Sync x/y attrs from the placement coordinate when the table declares
  // those CSV columns (e.g. space, where x/y *are* the persisted position).
  // For tables that don't (column, equipment, …), the keys aren't in
  // mergedAttrs so this is a no-op.
  const attrs: Record<string, string> = { ...mergedAttrs, id, [sxKey]: String(w) };
  // A blank Y size stays blank where it means something (round pile).
  if (mergedAttrs[syKey] !== '' || sxKey === 'size_x') attrs[syKey] = String(h);
  if ('x' in attrs) attrs.x = String(pt.x);
  if ('y' in attrs) attrs.y = String(pt.y);

  const element: PointElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'point',
    position: { x: pt.x, y: pt.y },
    width: w,
    height: h,
    attrs,
  };

  ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  ctx.setSnap(null);
}
