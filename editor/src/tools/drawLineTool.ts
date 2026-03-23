import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { resolveNextLevelId } from './levelUtil.ts';

export const drawLineTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor);
    const pt = snap.point;
    ctx.setSnap(snap);

    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      // First click — set start point
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [pt], cursor: pt },
      });
    } else {
      // Second click — create element
      const target = state.drawingTarget;
      if (!target) return;

      const start = points[0];
      const end = pt;

      const existingIds = new Set(state.document?.elements.keys() ?? []);
      const id = generateId(target.tableName, existingIds);
      const da = state.drawingAttrs;

      // Resolve strokeWidth: walls use 'thickness', ducts/pipes use 'size_x'
      const strokeWidth = resolveLineStrokeWidth(target.tableName, da) ?? FALLBACK_STROKE[target.tableName] ?? 0.1;

      // Merge drawingAttrs into element attrs
      const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
      const mergedAttrs = { ...baseAttrs, ...da, id };

      const element: LineElement = {
        id,
        tableName: target.tableName,
        discipline: target.discipline,
        geometry: 'line',
        start,
        end,
        strokeWidth,
        attrs: mergedAttrs,
      };

      ctx.dispatch({ type: 'CREATE_ELEMENT', element });
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
      ctx.setSnap(null);
    }
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor);
    const pt = snap.point;

    if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { ...state.drawingState, cursor: pt },
      });
      ctx.setSnap(snap);
    } else {
      ctx.setSnap(snap.snapX || snap.snapY ? snap : null);
    }
  },
};

const FALLBACK_STROKE: Record<string, number> = {
  wall: 0.2, curtain_wall: 0.05, structure_wall: 0.2,
  duct: 0.2, pipe: 0.05, conduit: 0.025, cable_tray: 0.1,
  door: 0.1, window: 0.1,
};
