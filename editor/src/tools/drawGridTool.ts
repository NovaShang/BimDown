import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement, Point } from '../model/elements.ts';
import type { GridData } from '../types.ts';
import { generateId } from '../model/ids.ts';
import { snapPoint, type SnapResult } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { orthoSnap } from './orthoLock.ts';

/** Grid letters in drafting order: I and O are skipped (they read as 1 and 0). */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function letterLabel(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % LETTERS.length;
    s = LETTERS[r] + s;
    n = Math.floor((n - 1) / LETTERS.length);
  }
  return s;
}

function letterIndex(label: string): number {
  if (!/^[A-Z]+$/.test(label)) return -1;
  let n = 0;
  for (const c of label) {
    const k = LETTERS.indexOf(c);
    if (k < 0) return -1;
    n = n * LETTERS.length + k + 1;
  }
  return n - 1;
}

/**
 * Default name of a new grid line: grids running across the plan (more
 * horizontal than vertical) are lettered A, B, C…, the others numbered 1,
 * 2, 3…, each continuing after the highest name of its kind.
 */
export function nextGridLabel(grids: readonly Pick<GridData, 'number'>[], horizontal: boolean): string {
  const taken = new Set(grids.map(g => g.number.trim().toUpperCase()));
  if (horizontal) {
    let i = Math.max(-1, ...grids.map(g => letterIndex(g.number.trim().toUpperCase()))) + 1;
    while (taken.has(letterLabel(i))) i++;
    return letterLabel(i);
  }
  const nums = grids.map(g => g.number.trim()).filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10));
  let n = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

function pick(ctx: ToolContext, e: React.PointerEvent): SnapResult | null {
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (!raw) return null;
  const state = ctx.getState();
  const anchor = state.drawingState?.points[0] ?? undefined;
  const snap = snapPoint(raw, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
  return orthoSnap(anchor, raw, snap, e.shiftKey);
}

/** The grid line drawn from `first` to `second` click: the bubble (drawn at
 *  the line's start) goes at the second click, where Revit puts the head. */
export function gridFromClicks(first: Point, second: Point): { start: Point; end: Point } {
  return { start: second, end: first };
}

export const drawGridTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const snap = pick(ctx, e);
    if (!snap) return;
    const pt = snap.point;
    ctx.setSnap(snap);

    const state = ctx.getState();
    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [pt], cursor: pt },
      });
    } else {
      const first = points[0];
      if (Math.hypot(pt.x - first.x, pt.y - first.y) < 1e-3) return;

      const existingIds = new Set(state.document?.elements.keys() ?? []);
      const id = generateId('grid', existingIds);
      const horizontal = Math.abs(pt.x - first.x) >= Math.abs(pt.y - first.y);

      const element: LineElement = {
        id,
        tableName: 'grid',
        discipline: 'reference',
        geometry: 'line',
        ...gridFromClicks(first, pt),
        strokeWidth: 0.06,
        attrs: { number: nextGridLabel(state.grids, horizontal) },
      };

      ctx.dispatch({ type: 'CREATE_ELEMENT', element });
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
      ctx.setSnap(null);
    }
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const snap = pick(ctx, e);
    if (!snap) return;
    const state = ctx.getState();
    if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { ...state.drawingState, cursor: snap.point },
      });
    }
    ctx.setSnap(snap);
  },
};
