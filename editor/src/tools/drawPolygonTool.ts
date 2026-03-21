import type { ToolHandler, ToolContext } from './types.ts';
import type { PolygonElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

/** Minimum 3 vertices to form a polygon */
const MIN_VERTICES = 3;
/** Distance in SVG units to auto-close polygon when clicking near start */
const CLOSE_DISTANCE = 0.5;

export const drawPolygonTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points || [];

    // Check if closing the polygon (click near first point)
    if (points.length >= MIN_VERTICES) {
      const first = points[0];
      const dx = svgPt.x - first.x;
      const dy = svgPt.y - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < CLOSE_DISTANCE) {
        createPolygon(ctx, points);
        return;
      }
    }

    // Add vertex
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [...points, svgPt], cursor: svgPt },
    });
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points || [];
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points, cursor: svgPt },
    });
  },
};

function createPolygon(ctx: ToolContext, vertices: { x: number; y: number }[]) {
  const state = ctx.getState();
  const target = state.drawingTarget;
  if (!target) return;

  const id = generateId(target.tableName, new Set());

  const element: PolygonElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'polygon',
    vertices,
    attrs: { id, ...defaultAttrs(target.tableName, '') },
  };

  ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}
