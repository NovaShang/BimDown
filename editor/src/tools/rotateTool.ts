import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { toElementId } from '../model/ids.ts';

/**
 * Rotate tool: click around a point element to set its rotation angle.
 * The angle is determined by the mouse position relative to the element center.
 *
 * Uses drawingState to show preview:
 * - points[0] = element center
 * - cursor = mouse position (for angle preview line)
 */
export const rotateTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    if (state.selectedIds.size !== 1 || !state.document) return;

    const sid = [...state.selectedIds][0];
    const el = state.document.elements.get(toElementId(sid));
    if (!el || el.geometry !== 'point') return;

    const center = (el as PointElement).position;
    const dx = svgPt.x - center.x;
    const dy = svgPt.y - center.y;
    const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    // Snap to nearest 15° increment
    const angleDeg = Math.round(rawAngle / 15) * 15;

    // UPDATE_ATTRS updates document.elements AND creates undo history
    ctx.dispatch({ type: 'UPDATE_ATTRS', id: sid, attrs: { rotation: String(angleDeg) } });

    // Return to select
    ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    if (state.selectedIds.size !== 1 || !state.document) return;

    const sid = [...state.selectedIds][0];
    const el = state.document.elements.get(toElementId(sid));
    if (!el || el.geometry !== 'point') return;

    const center = (el as PointElement).position;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [center], cursor: svgPt },
    });
  },
};
