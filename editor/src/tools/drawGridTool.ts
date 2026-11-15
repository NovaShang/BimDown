import type { ToolHandler, ToolContext } from './types.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { snapPoint, type SnapResult } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { orthoSnap } from './orthoLock.ts';
import { nextGridName } from '../model/copySet.ts';

// ─── Grid labels ─────────────────────────────────────────────────────────────

/** How new grids are named: by direction (vertical axes 1, 2, 3; horizontal A, B, C), or always one sequence. */
export type GridLabelScheme = 'auto' | 'numbers' | 'letters';

export interface GridDrawOptions {
  scheme: GridLabelScheme;
  /** Auto: which axes take numbers (the others take letters). */
  numbersOn: 'vertical' | 'horizontal';
  /** Name of the next grid, typed by the user ('' = continue the sequence). */
  next: string;
}

const KEY = 'bimdown-grid-draw-options';
const DEFAULTS: GridDrawOptions = { scheme: 'auto', numbersOn: 'vertical', next: '' };

function load(): GridDrawOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), next: '' };
  } catch { /* unavailable storage */ }
  return { ...DEFAULTS };
}

let gridOptions: GridDrawOptions = load();
const listeners = new Set<() => void>();

export function getGridDrawOptions(): GridDrawOptions { return gridOptions; }

export function setGridDrawOptions(patch: Partial<GridDrawOptions>): void {
  gridOptions = { ...gridOptions, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify({ ...gridOptions, next: '' })); } catch { /* unavailable storage */ }
  for (const l of listeners) l();
}

export function subscribeGridDrawOptions(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The sequence a grid from `start` to `end` takes. */
export function gridSequence(start: Point, end: Point, o: GridDrawOptions = gridOptions): 'numbers' | 'letters' {
  if (o.scheme !== 'auto') return o.scheme;
  const vertical = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x);
  return vertical === (o.numbersOn === 'vertical') ? 'numbers' : 'letters';
}

/** The next free name of a sequence: after the highest number (1, 2, 3…) or letter (A…Z, AA…). */
export function nextGridLabel(names: Iterable<string>, sequence: 'numbers' | 'letters', typed = ''): string {
  const used = new Set([...names].map(n => n.trim()).filter(Boolean));
  const t = typed.trim();
  if (t) return used.has(t) ? nextGridName(t, used) : t;
  if (sequence === 'numbers') {
    let top = 0;
    for (const n of used) if (/^\d+$/.test(n)) top = Math.max(top, parseInt(n, 10));
    for (let i = top + 1; ; i++) if (!used.has(String(i))) return String(i);
  }
  // Letters in drafting order (no I / O), after the highest one used
  let top = -1;
  for (const n of used) top = Math.max(top, letterIndex(n.toUpperCase()));
  for (let i = top + 1; ; i++) if (!used.has(letterLabel(i))) return letterLabel(i);
}

/** Names of the project grids (state.grids plus any in the open document). */
function usedGridNames(state: ReturnType<ToolContext['getState']>): string[] {
  const out = state.grids.map(g => g.number);
  for (const el of state.document?.elements.values() ?? []) if (el.tableName === 'grid' && el.attrs.number) out.push(el.attrs.number);
  return out;
}

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

      // Next name of the axis's sequence (or the one typed in the options bar)
      const name = nextGridLabel(usedGridNames(state), gridSequence(first, pt), gridOptions.next);
      if (gridOptions.next) setGridDrawOptions({ next: '' });

      const element: LineElement = {
        id,
        tableName: 'grid',
        discipline: 'reference',
        geometry: 'line',
        ...gridFromClicks(first, pt),
        strokeWidth: 0.06,
        attrs: { number: name },
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
