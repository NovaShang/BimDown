import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

export const drawLineTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      // First click — set start point
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [svgPt], cursor: svgPt },
      });
    } else {
      // Second click — create element
      const target = state.drawingTarget;
      if (!target) return;

      const start = points[0];
      const end = svgPt;

      // Generate unique ID
      const existingIds = new Set(
        Array.from((ctx as any).getState?.() || {}).length ? [] : []
      );
      // Use a simple approach: dispatch will handle ID conflicts
      const id = generateId(target.tableName, existingIds);

      const element: LineElement = {
        id,
        tableName: target.tableName,
        discipline: target.discipline,
        geometry: 'line',
        start,
        end,
        strokeWidth: getDefaultStrokeWidth(target.tableName),
        attrs: { id, ...defaultAttrs(target.tableName, '') },
      };

      ctx.dispatch({ type: 'CREATE_ELEMENT', element });
      // Reset drawing state for next element
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    }
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { ...state.drawingState, cursor: svgPt },
      });
    }
  },
};

function getDefaultStrokeWidth(tableName: string): number {
  switch (tableName) {
    case 'wall': case 'structure_wall': return 0.2;
    case 'duct': return 0.2;
    case 'pipe': return 0.05;
    case 'conduit': return 0.025;
    case 'cable_tray': return 0.1;
    case 'door': case 'window': return 0.1;
    default: return 0.1;
  }
}
