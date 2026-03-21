import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

export const drawPointTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;

    const defaults = defaultAttrs(target.tableName, '');
    const w = parseFloat(defaults.size_x || '0.3');
    const h = parseFloat(defaults.size_y || '0.3');

    const id = generateId(target.tableName, new Set());

    const element: PointElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'point',
      position: { x: svgPt.x - w / 2, y: svgPt.y - h / 2 },
      width: w,
      height: h,
      attrs: { id, ...defaults },
    };

    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [], cursor: svgPt },
    });
  },
};
