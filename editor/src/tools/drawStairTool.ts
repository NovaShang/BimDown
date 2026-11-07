/**
 * Stair placement tool (stair by component). Clicks along the walking line,
 * depending on `drawingAttrs.stair_type`:
 *   - straight                  → 2 clicks: bottom, top
 *   - quarter_turn (L)          → 3 clicks: start, corner, end
 *   - half_turn (U)             → 4 clicks: start, landing entry, landing exit, end
 *   - winder / spiral / curved / double_return → 2-click straight fallback.
 *
 * One placement creates, as one undo step (geometry/stair.ts layoutStair):
 * the stair (= its first run), the stair_landing / stair_run rows after it
 * (hosted on the stair) and, per the drawing bar's Railings option (default
 * both sides), CSV-only stair railings whose path follows the stair.
 *
 * Rise: base_offset → top level + top_offset (the vertical span, as for a
 * straight stair); `step_count` is the stair's total riser count, shared out
 * over the runs in proportion to their length.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { Point } from '../model/elements.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { getProjectUnits } from '../utils/units.ts';
import { layoutStair } from '../geometry/stair.ts';
import { stairElements, STAIR_RAILINGS_KEY } from '../model/stairElements.ts';

/** Clicks a stair type needs (the walking line's points). */
export function clicksRequired(stairType: string | undefined): number {
  switch (stairType) {
    case 'quarter_turn': return 3;
    case 'half_turn':    return 4;
    // straight / winder / spiral / curved / double_return → 2-click fallback
    default:             return 2;
  }
}

/** True when the active stair_type calls for the multi-click path. */
export function isMultiClickStair(stairType: string | undefined): boolean {
  return clicksRequired(stairType) > 2;
}

function snapAt(ctx: ToolContext, e: React.PointerEvent) {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const points = state.drawingState?.points ?? [];
  const anchor = points.length > 0 ? points[points.length - 1] : undefined;
  return snapPoint(
    svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids,
    undefined, undefined, getProjectUnits(state), state.disabledSnapTypes,
  );
}

export const drawStairTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const snap = snapAt(ctx, e);
    if (!snap) return;
    ctx.setSnap(snap);
    const state = ctx.getState();
    const points = [...(state.drawingState?.points ?? []), snap.point];
    if (points.length < clicksRequired(state.drawingAttrs.stair_type)) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points, cursor: snap.point } });
      return;
    }
    placeStair(ctx, state, points);
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const snap = snapAt(ctx, e);
    if (!snap) return;
    const points = ctx.getState().drawingState?.points ?? [];
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points, cursor: snap.point } });
    ctx.setSnap(snap);
  },
};

const num = (s: string | undefined, fallback: number) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Level-relative rise of the stair being drawn: base_offset → top level + top_offset. */
export function stairSpan(state: Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs'>): { baseZ: number; topZ: number } {
  const da = state.drawingAttrs;
  const levels = state.project?.levels ?? [];
  const curId = state.document?.levelId ?? '';
  const curElev = levels.find(l => l.id === curId)?.elevation ?? 0;
  const baseZ = num(da.base_offset, 0);
  const topLevel = levels.find(l => l.id === (da.top_level_id || curId));
  let topZ = (topLevel?.elevation ?? curElev) - curElev + num(da.top_offset, 0);
  if (topZ - baseZ < 1e-6) topZ = baseZ + 3;
  return { baseZ, topZ };
}

function placeStair(ctx: ToolContext, state: ToolStateSnapshot, points: Point[]) {
  const da = state.drawingAttrs;
  const width = num(da.width, 1.2) || 1.2;
  const steps = Math.max(2, Math.round(num(da.step_count, 18)));
  const { baseZ, topZ } = stairSpan(state);
  const layout = layoutStair(points, width, steps, baseZ, topZ);
  if (!layout) return;
  const levelId = state.document?.levelId ?? '';
  const elements = stairElements({
    layout,
    existingIds: state.document?.elements.keys() ?? [],
    levelId,
    attrs: { ...defaultAttrs('stair', resolveNextLevelId(state)), ...da },
    width,
    railings: da[STAIR_RAILINGS_KEY],
  });
  ctx.dispatch({ type: 'CREATE_ELEMENTS', elements, description: 'Place stair' });
}
