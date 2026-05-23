import type { ToolHandler, ToolContext } from './types.ts';
import type { PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';

export const drawPointTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state));
    const pt = snap.point;

    const target = state.drawingTarget;
    if (!target) return;

    const da = state.drawingAttrs;
    const baseDefaults = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const vDefaults = variantDefaults(target.tableName, target.variantId);
    const mergedAttrs = { ...baseDefaults, ...vDefaults, ...da };

    const w = parseFloat(mergedAttrs.size_x || '0.3');
    const h = parseFloat(mergedAttrs.size_y || '0.3');

    const existingIds = new Set(state.document?.elements.keys() ?? []);
    const id = generateId(target.tableName, existingIds);

    // Sync x/y attrs from the placement coordinate when the table declares
    // those CSV columns (e.g. space, where x/y *are* the persisted position).
    // For tables that don't (column, equipment, …), the keys aren't in
    // mergedAttrs so this is a no-op.
    const attrs: Record<string, string> = { ...mergedAttrs, id, size_x: String(w), size_y: String(h) };
    if ('x' in attrs) attrs.x = String(pt.x);
    if ('y' in attrs) attrs.y = String(pt.y);

    const element: PointElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'point',
      position: { x: pt.x, y: pt.y },
      width: w,
      height: h,
      attrs,
    };

    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state));
    const pt = snap.point;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [], cursor: pt },
    });
    ctx.setSnap(snap);
  },
};
