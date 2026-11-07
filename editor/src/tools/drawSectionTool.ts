import type { ToolHandler, ToolContext } from './types.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { nextSectionId, nextSectionName } from '../views/sectionsIO.ts';
import type { SectionDef } from '../views/viewTypes.ts';

/** Two clicks in the plan: start and end of a section line. The view looks to
 *  the left of start→end; the new section opens in the view pane. */
export const drawSectionTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points ?? [];
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, points[0], undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;

    if (points.length === 0) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [pt], cursor: pt } });
      ctx.setSnap(snap);
      return;
    }

    const start = points[0];
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
    ctx.setSnap(null);
    if (Math.hypot(pt.x - start.x, pt.y - start.y) < 0.1) return;

    const existing = state.project?.sections ?? [];
    const section: SectionDef = { id: nextSectionId(existing), name: nextSectionName(existing), start, end: pt };
    ctx.dispatch({ type: 'UPDATE_SECTIONS', sections: [...existing, section], persist: true });
    ctx.dispatch({ type: 'OPEN_VIEW', view: { kind: 'section', id: section.id } });
    ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;
    const state = ctx.getState();
    const anchor = state.drawingState?.points[0];
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...state.drawingState, cursor: snap.point } });
    }
    ctx.setSnap(snap);
  },
};
