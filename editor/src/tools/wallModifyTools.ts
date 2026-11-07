/**
 * Modify tools for walls (Revit TR / single trim / SL):
 *   trim_corner — pick two walls; both trim or extend to their corner, the
 *                 picked sides are kept.
 *   trim_single — pick a reference (wall or grid line), then a wall to trim
 *                 or extend to it.
 *   split       — click a wall to split it there; hosted doors / windows go
 *                 to the half they sit in.
 * The tools stay active after each operation; Esc drops the first pick, then
 * leaves the tool.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { EditorAction, Tool } from '../state/editorTypes.ts';
import type { Point } from '../model/elements.ts';
import { computePixelSize, nearestPointOnSegment, snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { isJoinable } from '../geometry/wallJoins.ts';
import { nearestPointOnArc } from '../geometry/arc.ts';
import {
  refLineOfElement, splitWall, straightWall, trimExtendToCorner, trimExtendToReference, type RefLine,
} from '../geometry/wallEdit.ts';

const GRID_PREFIX = 'grid:';

/** Shortcut key → modify tool (2D, disciplines that draw walls). */
export const MODIFY_TOOL_SHORTCUTS: Record<string, Tool> = { J: 'trim_corner', E: 'trim_single', K: 'split' };

export function enterModifyTool(dispatch: (a: EditorAction) => void, tool: Tool) {
  dispatch({ type: 'SET_TOOL', tool });
  dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  dispatch({ type: 'CLEAR_SELECTION' });
}

function svgAt(ctx: ToolContext, e: { clientX: number; clientY: number }): Point | null {
  return ctx.screenToSvg(e.clientX, e.clientY);
}

/** Nearest wall-like element under `p` (within its thickness plus a few px). */
export function wallAt(ctx: ToolContext, state: ToolStateSnapshot, p: Point, straightOnly: boolean): string | null {
  const tol = computePixelSize(ctx.screenToSvg) * 6;
  let best: string | null = null, bestD = Infinity;
  for (const el of state.document?.elements.values() ?? []) {
    if (!isJoinable(el) || (straightOnly && el.arc)) continue;
    const q = el.arc ? nearestPointOnArc(p, el.start, el.end, el.arc).point : nearestPointOnSegment(p, el.start, el.end);
    const d = Math.hypot(q.x - p.x, q.y - p.y) - el.strokeWidth / 2;
    if (d <= tol && d < bestD) { bestD = d; best = el.id; }
  }
  return best;
}

function gridAt(ctx: ToolContext, state: ToolStateSnapshot, p: Point): string | null {
  const tol = computePixelSize(ctx.screenToSvg) * 6;
  let best: string | null = null, bestD = tol;
  for (const g of state.grids) {
    const q = nearestPointOnSegment(p, { x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) { bestD = d; best = GRID_PREFIX + g.id; }
  }
  return best;
}

function refLine(state: ToolStateSnapshot, id: string): RefLine | null {
  if (id.startsWith(GRID_PREFIX)) {
    const g = state.grids.find(gr => gr.id === id.slice(GRID_PREFIX.length));
    if (!g) return null;
    const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    return len > 1e-9 ? { p: { x: g.x1, y: g.y1 }, d: { x: (g.x2 - g.x1) / len, y: (g.y2 - g.y1) / len } } : null;
  }
  return refLineOfElement(state.document?.elements.get(id));
}

/** Highlight the element the next click would pick (SVG data-id is the raw id). */
function hover(ctx: ToolContext, state: ToolStateSnapshot, id: string | null) {
  const next = id && !id.startsWith(GRID_PREFIX) ? id : null;
  if (next !== state.hoveredId) ctx.dispatch({ type: 'SET_HOVER', id: next });
}

/** Centreline of a picked wall or grid, drawn highlighted until the second pick. */
function pickedLine(state: ToolStateSnapshot, id: string): { start: Point; end: Point } | undefined {
  if (id.startsWith(GRID_PREFIX)) {
    const g = state.grids.find(gr => gr.id === id.slice(GRID_PREFIX.length));
    return g ? { start: { x: g.x1, y: g.y1 }, end: { x: g.x2, y: g.y2 } } : undefined;
  }
  const el = state.document?.elements.get(id);
  return el && (el.geometry === 'line' || el.geometry === 'spatial_line') ? { start: el.start, end: el.end } : undefined;
}

function resetPick(ctx: ToolContext) {
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}

function escKey(ctx: ToolContext, e: KeyboardEvent): boolean {
  if (e.key !== 'Escape') return false;
  const state = ctx.getState();
  if (state.drawingState?.pick) {
    resetPick(ctx);
  } else {
    ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
    ctx.dispatch({ type: 'SET_HOVER', id: null });
  }
  return true;
}

function twoPickTool(
  firstAt: (ctx: ToolContext, state: ToolStateSnapshot, p: Point) => string | null,
  apply: (ctx: ToolContext, state: ToolStateSnapshot, first: { id: string; point: Point }, secondId: string, p: Point) => boolean,
): ToolHandler {
  return {
    cursor: 'crosshair',
    onPointerDown(ctx, e) {
      if (e.button !== 0) return;
      const p = svgAt(ctx, e);
      if (!p) return;
      const state = ctx.getState();
      const pick = state.drawingState?.pick;
      if (!pick) {
        const id = firstAt(ctx, state, p);
        if (!id) return;
        ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p, pick: { id, point: p, line: pickedLine(state, id) } } });
        return;
      }
      const second = wallAt(ctx, state, p, true);
      if (!second || second === pick.id) return;
      if (apply(ctx, state, pick, second, p)) resetPick(ctx);
    },
    onPointerMove(ctx, e) {
      const p = svgAt(ctx, e);
      if (!p) return;
      const state = ctx.getState();
      hover(ctx, state, state.drawingState?.pick ? wallAt(ctx, state, p, true) : firstAt(ctx, state, p));
    },
    onKeyDown: escKey,
  };
}

export const trimCornerTool = twoPickTool(
  (ctx, state, p) => wallAt(ctx, state, p, true),
  (ctx, state, first, second, p) => {
    const els = state.document?.elements;
    const patch = els && trimExtendToCorner(els, first.id, first.point, second, p);
    if (!patch) return false;
    ctx.dispatch({ type: 'APPLY_PATCH', description: 'Trim/Extend to corner', patches: patch });
    return true;
  },
);

export const trimSingleTool = twoPickTool(
  (ctx, state, p) => wallAt(ctx, state, p, true) ?? gridAt(ctx, state, p),
  (ctx, state, first, second, p) => {
    const els = state.document?.elements;
    const ref = refLine(state, first.id);
    const patch = els && ref && straightWall(els, second) && trimExtendToReference(els, ref, second, p);
    if (!patch) return false;
    ctx.dispatch({ type: 'APPLY_PATCH', description: 'Trim/Extend to reference', patches: patch });
    return true;
  },
);

export const splitTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const raw = svgAt(ctx, e);
    if (!raw) return;
    const state = ctx.getState();
    const id = wallAt(ctx, state, raw, false);
    if (!id || !state.document) return;
    const snap = snapPoint(raw, ctx.screenToSvg, state.document.elements, new Set([id]), undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const r = splitWall(state.document.elements, id, snap.point);
    if (!r) return;
    ctx.dispatch({ type: 'APPLY_PATCH', description: 'Split wall', patches: r.patch });
  },
  onPointerMove(ctx, e) {
    const p = svgAt(ctx, e);
    if (!p) return;
    const state = ctx.getState();
    hover(ctx, state, wallAt(ctx, state, p, false));
  },
  onKeyDown: escKey,
};
