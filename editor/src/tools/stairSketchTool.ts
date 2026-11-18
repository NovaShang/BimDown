/**
 * Stair by sketch (stair toolbar variant "Sketch", Revit "Create Sketch"):
 *   - Boundary mode: click the outline's corners; clicking the first corner
 *     closes it and switches to risers.
 *   - Riser mode: two clicks per riser line, the first riser at the bottom.
 *   - Backspace removes the last point / riser; Esc drops the point in
 *     progress (again: leaves the tool); Enter builds the stair.
 * Enter turns the sketch into normal stair / stair_run / stair_landing rows
 * (geometry/stairSketch.ts) plus the drawing bar's railings, one undo step.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { Point } from '../model/elements.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { sketchToLayout, type StairSketch } from '../geometry/stairSketch.ts';
import { SKETCH_MODE_KEY, stairElements, STAIR_RAILINGS_KEY } from '../model/stairElements.ts';
import { showNotice } from '../state/modifyUi.ts';
import { stairSpan } from './drawStairTool.ts';


export function sketchMode(da: Record<string, string>): 'boundary' | 'riser' {
  return da[SKETCH_MODE_KEY] === 'riser' ? 'riser' : 'boundary';
}

const emptySketch = (): StairSketch => ({ boundary: [], risers: [] });

function snapAt(ctx: ToolContext, e: React.PointerEvent, anchor?: Point) {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  return snapPoint(
    svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids,
    undefined, undefined, getProjectUnits(state), state.disabledSnapTypes,
  );
}

/** Close the boundary when a click lands this near (screen px) its first corner. */
const CLOSE_PX = 10;

/** `px` screen pixels in model units at the pointer. */
function pxToModel(ctx: ToolContext, e: React.PointerEvent, px: number): number {
  const a = ctx.screenToSvg(e.clientX, e.clientY), b = ctx.screenToSvg(e.clientX + px, e.clientY);
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
}

export const stairSketchTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const state = ctx.getState();
    const ds = state.drawingState;
    const points = ds?.points ?? [];
    const snap = snapAt(ctx, e, points[points.length - 1]);
    if (!snap) return;
    const p = snap.point;
    const sketch = ds?.stairSketch ?? emptySketch();
    if (sketchMode(state.drawingAttrs) === 'boundary') {
      const first = points[0];
      if (first && points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < pxToModel(ctx, e, CLOSE_PX)) {
        ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p, stairSketch: { ...sketch, boundary: points } } });
        ctx.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...state.drawingAttrs, [SKETCH_MODE_KEY]: 'riser' } });
        return;
      }
      // A new outline replaces a closed one
      const base = points.length === 0 && sketch.boundary.length > 0 ? { ...sketch, boundary: [] } : sketch;
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [...points, p], cursor: p, stairSketch: base } });
      return;
    }
    if (points.length === 0) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [p], cursor: p, stairSketch: sketch } });
      return;
    }
    const a = points[0];
    if (Math.hypot(p.x - a.x, p.y - a.y) < 1e-6) return;
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p, stairSketch: { ...sketch, risers: [...sketch.risers, [a, p]] } } });
  },

  onPointerMove(ctx, e) {
    const state = ctx.getState();
    const ds = state.drawingState;
    const points = ds?.points ?? [];
    const snap = snapAt(ctx, e, points[points.length - 1]);
    if (!snap) return;
    ctx.setSnap(snap);
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...(ds ?? { points: [] }), points, cursor: snap.point } });
  },

  onKeyDown(ctx, e) {
    const state = ctx.getState();
    const ds = state.drawingState;
    const points = ds?.points ?? [];
    const sketch = ds?.stairSketch ?? emptySketch();
    if (e.key === 'Escape') {
      if (points.length === 0) return false;
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds!, points: [] } });
      return true;
    }
    if (e.key === 'Backspace') {
      if (points.length > 0) ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds!, points: points.slice(0, -1) } });
      else if (sketch.risers.length > 0) ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...(ds ?? { cursor: null }), points: [], stairSketch: { ...sketch, risers: sketch.risers.slice(0, -1) } } });
      else return false;
      return true;
    }
    if (e.key === 'Enter') {
      finishSketch(ctx, state, sketch, points);
      return true;
    }
    return false;
  },
};

/** Build the sketched stair (an open boundary in progress counts as closed). */
export function finishSketch(ctx: ToolContext, state: ToolStateSnapshot, sketch: StairSketch, points: Point[]): boolean {
  const sk = sketchMode(state.drawingAttrs) === 'boundary' && points.length >= 3 ? { ...sketch, boundary: points } : sketch;
  const { baseZ, topZ } = stairSpan(state);
  const layout = sketchToLayout(sk, baseZ, topZ);
  if ('error' in layout) {
    showNotice(`notice.stairSketch_${layout.error}`);
    return false;
  }
  const da = state.drawingAttrs;
  const width = layout.runs[0].width ?? 1.2;
  const stairType = layout.landings.some(l => l.steps) ? 'winder'
    : layout.runs.length === 1 ? 'straight'
    : layout.runs.length === 2 ? turnType(layout.runs[0].start, layout.runs[0].end, layout.runs[1].start, layout.runs[1].end) : 'straight';
  const elements = stairElements({
    layout,
    existingIds: state.document?.elements.keys() ?? [],
    levelId: state.document?.levelId ?? '',
    attrs: { ...defaultAttrs('stair', resolveNextLevelId(state)), ...da, stair_type: stairType },
    width,
    railings: da[STAIR_RAILINGS_KEY],
  });
  ctx.dispatch({ type: 'CREATE_ELEMENTS', elements, description: 'Sketch stair' });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, stairSketch: emptySketch() } });
  ctx.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...da, [SKETCH_MODE_KEY]: 'boundary' } });
  return true;
}

/** straight / quarter_turn / half_turn from the directions of two runs. */
function turnType(a0: Point, a1: Point, b0: Point, b1: Point): string {
  const ua = { x: a1.x - a0.x, y: a1.y - a0.y }, ub = { x: b1.x - b0.x, y: b1.y - b0.y };
  const c = (ua.x * ub.x + ua.y * ub.y) / ((Math.hypot(ua.x, ua.y) * Math.hypot(ub.x, ub.y)) || 1);
  return c > 0.7 ? 'straight' : c < -0.7 ? 'half_turn' : 'quarter_turn';
}
