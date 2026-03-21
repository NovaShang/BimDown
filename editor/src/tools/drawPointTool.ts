import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';

export const drawPointTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements);
    const pt = snap.point;

    const target = state.drawingTarget;
    if (!target) return;

    const da = state.drawingAttrs;
    const baseDefaults = defaultAttrs(target.tableName, '');
    const mergedAttrs = { ...baseDefaults, ...da };

    const w = parseFloat(mergedAttrs.size_x || '0.3');
    const h = parseFloat(mergedAttrs.size_y || '0.3');

    const existingIds = new Set(state.document?.elements.keys() ?? []);
    const id = generateId(target.tableName, existingIds);

    const element: PointElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'point',
      position: { x: pt.x - w / 2, y: pt.y - h / 2 },
      width: w,
      height: h,
      attrs: { ...mergedAttrs, id, size_x: String(w), size_y: String(h) },
    };

    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements);
    const pt = snap.point;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [], cursor: pt },
    });
    ctx.setSnap(snap.snapX || snap.snapY ? snap : null);
  },
};
