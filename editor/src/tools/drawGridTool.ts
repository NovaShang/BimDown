import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { snapPoint } from '../utils/snap.ts';

export const drawGridTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids);
    const pt = snap.point;
    ctx.setSnap(snap);

    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [pt], cursor: pt },
      });
    } else {
      const start = points[0];

      const existingIds = new Set(state.document?.elements.keys() ?? []);
      const id = generateId('grid', existingIds);

      // Auto-assign next grid number
      const existingNumbers = state.grids
        .map(g => parseInt(g.number, 10))
        .filter(n => !isNaN(n));
      const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;

      const element: LineElement = {
        id,
        tableName: 'grid',
        discipline: 'reference',
        geometry: 'line',
        start,
        end: pt,
        strokeWidth: 0.06,
        attrs: { number: String(nextNumber) },
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
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids);
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
