import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';

export const drawLineTool: ToolHandler = {
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
      const strokeWidth = resolveStrokeWidth(target.tableName, da);

      // Merge drawingAttrs into element attrs
      const baseAttrs = defaultAttrs(target.tableName, '');
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
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements);
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

function resolveStrokeWidth(tableName: string, da: Record<string, string>): number {
  // Wall thickness → strokeWidth
  if (tableName === 'wall' || tableName === 'structure_wall') {
    const v = parseFloat(da.thickness);
    if (v > 0) return v;
    return 0.2;
  }
  // Ducts/pipes/conduits — use size_x as visual width
  if (da.size_x) {
    const v = parseFloat(da.size_x);
    if (v > 0) return v;
  }
  // Fallbacks
  switch (tableName) {
    case 'duct': return 0.2;
    case 'pipe': return 0.05;
    case 'conduit': return 0.025;
    case 'cable_tray': return 0.1;
    case 'door': case 'window': return 0.1;
    default: return 0.1;
  }
}
