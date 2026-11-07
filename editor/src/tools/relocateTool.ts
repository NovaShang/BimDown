import type { ToolHandler, ToolContext } from './types.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { toElementId } from '../model/ids.ts';
import { typedKey, resolveTypedPoint } from './typedInput.ts';

/** Strip the `level:` prefix from selection ids so they match the raw keys
 *  used by `snapPoint`'s exclusion set. */
function toRawIdSet(ids: Set<string>): Set<string> {
  const raw = new Set<string>();
  ids.forEach(id => raw.add(toElementId(id)));
  return raw;
}

/**
 * Relocate tool: precise move/copy via click-start, click-end.
 *
 * Uses `drawingTarget.tableName` to distinguish mode:
 *   - 'move'  → dispatches MOVE_ELEMENTS
 *   - 'copy'  → dispatches DUPLICATE_ELEMENTS
 *
 * Drawing state tracks origin (points[0]) and cursor for preview.
 */
export const relocateTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, toRawIdSet(state.selectedIds), anchor, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;
    ctx.setSnap(snap);

    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      // First click — set origin
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [pt], cursor: pt },
      });
    } else {
      // Second click — execute move/copy
      execute(ctx, points[0], pt);
    }
  },

  /** Typed distance (and Tab → angle) after the origin click, Enter to apply. */
  onKeyDown(ctx: ToolContext, e: KeyboardEvent) {
    const state = ctx.getState();
    const ds = state.drawingState;
    const origin = ds?.points[0];
    if (!ds || !origin) return false;
    const r = typedKey(e, ds.typed);
    if (!r.handled) return false;
    e.preventDefault();
    const target = r.commit && r.typed ? resolveTypedPoint(origin, ds.cursor, r.typed, getProjectUnits(state)) : null;
    if (target) execute(ctx, origin, target);
    else ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, typed: r.typed } });
    return true;
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, toRawIdSet(state.selectedIds), anchor, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;

    if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { ...state.drawingState, cursor: pt },
      });
    }
    ctx.setSnap(snap);
  },
};

function execute(ctx: ToolContext, origin: { x: number; y: number }, pt: { x: number; y: number }) {
  const state = ctx.getState();
  const dx = pt.x - origin.x;
  const dy = pt.y - origin.y;
  const ids = Array.from(state.selectedIds);
  const mode = state.drawingTarget?.tableName;

  if (mode === 'copy') {
    ctx.dispatch({ type: 'DUPLICATE_ELEMENTS', ids, offset: { dx, dy } });
  } else {
    ctx.dispatch({ type: 'MOVE_ELEMENTS', ids, dx, dy });
  }

  // Return to select tool
  ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
  ctx.dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  ctx.setSnap(null);
}
