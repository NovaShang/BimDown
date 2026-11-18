/**
 * Slope arrow of a sloped floor (Revit "Slope Arrow"): started from the slab
 * properties panel, click the tail, then the head. The slab's `slope_arrow`
 * gets the two points; heights carry over from its previous arrow (else 0,
 * set them in the panel). One undo step; Esc cancels.
 */
import type { ToolHandler, ToolContext } from './types.ts';
import type { Point } from '../model/elements.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { formatSlopeArrow, parseSlopeArrow } from '../geometry/slabSlope.ts';

let targetId: string | null = null;

/** Begin drawing the slope arrow of slab `id`. */
export function startSlopeArrow(dispatch: (a: EditorAction) => void, id: string): void {
  targetId = id;
  dispatch({ type: 'SET_TOOL', tool: 'draw_slope_arrow' });
  dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}

/** `slope_arrow` for a new tail / head, keeping the heights of `prev`. */
export function arrowValue(prev: string | undefined, tail: Point, head: Point): string | null {
  if (Math.hypot(head.x - tail.x, head.y - tail.y) < 1e-6) return null;
  const p = parseSlopeArrow(prev);
  return formatSlopeArrow({ tail: { ...tail, z: p?.tail.z ?? 0 }, head: { ...head, z: p?.head.z ?? 0 } });
}

function snapped(ctx: ToolContext, e: React.PointerEvent): Point | null {
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (!raw) return null;
  const s = ctx.getState();
  const anchor = s.drawingState?.points[0];
  const snap = snapPoint(raw, ctx.screenToSvg, s.document?.elements, undefined, anchor, undefined, s.grids,
    undefined, undefined, getProjectUnits(s), s.disabledSnapTypes);
  ctx.setSnap(snap);
  return snap.point;
}

export const slopeArrowTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = snapped(ctx, e);
    const s = ctx.getState();
    const slab = targetId ? s.document?.elements.get(targetId) : undefined;
    if (!p || !slab) return;
    const pts = s.drawingState?.points ?? [];
    if (pts.length === 0) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [p], cursor: p } });
      return;
    }
    const value = arrowValue(slab.attrs.slope_arrow, pts[0], p);
    if (!value) return;
    ctx.dispatch({ type: 'UPDATE_ATTRS', id: slab.id, attrs: { slope_arrow: value } });
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
    ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
    ctx.dispatch({ type: 'SELECT', ids: [slab.id] });
    ctx.setSnap(null);
    targetId = null;
  },

  onPointerMove(ctx, e) {
    const p = snapped(ctx, e);
    if (!p) return;
    const pts = ctx.getState().drawingState?.points ?? [];
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: pts, cursor: p } });
  },
};
