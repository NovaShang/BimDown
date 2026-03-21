import type { ToolHandler, ToolContext } from './types.ts';
import type { PolygonElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';

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
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements);
    const pt = snap.point;
    ctx.setSnap(snap);

    const points = state.drawingState?.points || [];

    // Check if closing the polygon (click near first point)
    if (points.length >= MIN_VERTICES) {
      const first = points[0];
      const dx = pt.x - first.x;
      const dy = pt.y - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < CLOSE_DISTANCE) {
        createPolygon(ctx, points);
        ctx.setSnap(null);
        return;
      }
    }

    // Add vertex
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [...points, pt], cursor: pt },
    });
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements);
    const pt = snap.point;

    const points = state.drawingState?.points || [];
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points, cursor: pt },
    });
    ctx.setSnap(snap.snapX || snap.snapY ? snap : null);
  },
};

function createPolygon(ctx: ToolContext, vertices: { x: number; y: number }[]) {
  const state = ctx.getState();
  const target = state.drawingTarget;
  if (!target) return;

  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId(target.tableName, existingIds);
  const baseAttrs = defaultAttrs(target.tableName, '');
  const mergedAttrs = { ...baseAttrs, ...state.drawingAttrs, id };

  const element: PolygonElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'polygon',
    vertices,
    attrs: mergedAttrs,
  };

  ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}
