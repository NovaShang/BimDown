/**
 * Stair placement tool (stair by component). Clicks along the walking line,
 * depending on `drawingAttrs.stair_type`:
 *   - straight                  → 2 clicks: bottom, top
 *   - quarter_turn (L)          → 3 clicks: start, corner, end
 *   - half_turn (U)             → 4 clicks: start, landing entry, landing exit, end
 *     (Turn = Winders: the landing turns as winder treads, stair_type winder)
 *   - winder                    → 3 clicks, an L whose corner is 3 winders
 *   - curved / spiral           → 3 clicks: centre, a point on the walking
 *     line (radius, start), a point giving the direction; the sweep is
 *     risers × going on the walking line (layoutCurvedStair)
 *   - double_return → 2-click straight fallback.
 * The "Sketch" variant (tools/stairSketchTool.ts) draws boundary + risers.
 *
 * One placement creates, as one undo step (geometry/stair.ts layoutStair):
 * the stair (= its first run), the stair_landing / stair_run rows after it
 * (hosted on the stair) and, per the drawing bar's Railings option (default
 * both sides), CSV-only stair railings whose path follows the stair.
 *
 * Rise: base_offset → top level + top_offset (the vertical span, as for a
 * straight stair); `step_count` is the stair's total riser count. Runs are
 * locked to risers × going (typed, else 2R + G = 630 mm): the first run's
 * click snaps to whole treads, the last run ends after the remaining ones.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { Point } from '../model/elements.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { getProjectUnits } from '../utils/units.ts';
import { defaultGoing, fitStairPoints, layoutCurvedStair, layoutStair, type StairLayout } from '../geometry/stair.ts';
import { stairSketchTool } from './stairSketchTool.ts';
import { unitsPerMetreOf } from '../utils/units.ts';
import { stairElements, STAIR_RAILINGS_KEY, STAIR_TURN_KEY } from '../model/stairElements.ts';

/** Clicks a stair type needs (the walking line's points). */
export function clicksRequired(stairType: string | undefined): number {
  switch (stairType) {
    case 'quarter_turn': return 3;
    case 'winder':       return 3;
    case 'curved':
    case 'spiral':       return 3;
    case 'half_turn':    return 4;
    // straight / double_return → 2-click fallback
    default:             return 2;
  }
}

/** True when the active stair_type calls for the multi-click path. */
export function isMultiClickStair(stairType: string | undefined): boolean {
  return clicksRequired(stairType) > 2;
}

function snapAt(ctx: ToolContext, e: React.PointerEvent) {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const points = state.drawingState?.points ?? [];
  const anchor = points.length > 0 ? points[points.length - 1] : undefined;
  return snapPoint(
    svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids,
    undefined, undefined, getProjectUnits(state), state.disabledSnapTypes,
  );
}

/** Curved / spiral: clicks are centre, walking-line point, direction. */
export function isCurvedStair(stairType: string | undefined): boolean {
  return stairType === 'curved' || stairType === 'spiral';
}


/** Winder risers per turn of the stair being drawn (0 = flat landing): 3 for an L, 6 for a U. */
export function windersPerTurn(da: Record<string, string>): number {
  const t = da.stair_type;
  if (t === 'winder') return 3;
  if (da[STAIR_TURN_KEY] !== 'winders') return 0;
  return t === 'quarter_turn' ? 3 : t === 'half_turn' ? 6 : 0;
}

const isSketch = (state: Pick<ToolStateSnapshot, 'drawingTarget'>) => state.drawingTarget?.variantId === 'sketch';

export const drawStairTool: ToolHandler = {
  cursor: 'crosshair',

  onKeyDown(ctx: ToolContext, e: KeyboardEvent) {
    if (isSketch(ctx.getState())) return stairSketchTool.onKeyDown?.(ctx, e) ?? false;
    return false;
  },

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (isSketch(ctx.getState())) { stairSketchTool.onPointerDown?.(ctx, e); return; }
    if (e.button !== 0) return;
    const snap = snapAt(ctx, e);
    if (!snap) return;
    ctx.setSnap(snap);
    const state = ctx.getState();
    // Every click lands where the treads put it (run lengths locked to risers × going)
    let points = fitClicks(state, [...(state.drawingState?.points ?? []), snap.point]);
    if (points.length < clicksRequired(state.drawingAttrs.stair_type)) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points, cursor: snap.point } });
      return;
    }
    placeStair(ctx, state, points);
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (isSketch(ctx.getState())) { stairSketchTool.onPointerMove?.(ctx, e); return; }
    const snap = snapAt(ctx, e);
    if (!snap) return;
    const state = ctx.getState();
    const points = state.drawingState?.points ?? [];
    // The run being drawn is as long as its treads: the cursor gives the direction
    const fitted = fitClicks(state, [...points, snap.point]);
    const cursor = fitted[fitted.length - 1];
    const stairPreview = previewLayout(state, fitted) ?? undefined;
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points, cursor, stairPreview } });
    ctx.setSnap(snap);
  },
};

/** UI-only drawing attr: the going (tread depth) typed in the drawing bar, project units; empty = the default for the riser (2R + G = 630 mm). */
export const STAIR_GOING_KEY = '__going';

/** Going the stair being drawn uses (project units): typed, else the default for its riser height. */
export function drawGoing(state: Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs'>): number {
  const da = state.drawingAttrs;
  const typed = num(da[STAIR_GOING_KEY], 0);
  if (typed > 0) return typed;
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const { baseZ, topZ } = stairSpan(state);
  const steps = Math.max(2, Math.round(num(da.step_count, 18)));
  return defaultGoing((topZ - baseZ) / steps / upm) * upm;
}

/** Walking-line clicks (plus cursor) fitted so every run is its risers × going. */
export function fitClicks(state: Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs'>, points: Point[]): Point[] {
  const da = state.drawingAttrs;
  if (isCurvedStair(da.stair_type)) return fitCurvedClicks(points, num(da.width, 1.2) || 1.2);
  const steps = Math.max(2, Math.round(num(da.step_count, 18)));
  return fitStairPoints(points, clicksRequired(da.stair_type), num(da.width, 1.2) || 1.2, steps, drawGoing(state), windersPerTurn(da));
}

/** Curved stair clicks: the walking line keeps clear of the centre (inner edge at least 50 mm from it). */
function fitCurvedClicks(points: Point[], width: number): Point[] {
  if (points.length < 2) return points;
  const [c, p] = points;
  const d = Math.hypot(p.x - c.x, p.y - c.y);
  const min = width / 2 + 0.05;
  if (d >= min) return points;
  const ux = d > 1e-9 ? (p.x - c.x) / d : 1, uy = d > 1e-9 ? (p.y - c.y) / d : 0;
  return [c, { x: c.x + ux * min, y: c.y + uy * min }, ...points.slice(2)];
}

/** Layout of the stair the clicks (plus cursor) describe, all clicks given; null while incomplete. */
export function stairLayoutFor(state: Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs'>, points: Point[]): StairLayout | null {
  const da = state.drawingAttrs;
  const width = num(da.width, 1.2) || 1.2;
  const steps = Math.max(2, Math.round(num(da.step_count, 18)));
  const { baseZ, topZ } = stairSpan(state);
  if (isCurvedStair(da.stair_type)) {
    if (points.length < 3) return null;
    const [c, p, q] = points;
    const radius = Math.hypot(p.x - c.x, p.y - c.y);
    const a0 = Math.atan2(p.y - c.y, p.x - c.x);
    const ccw = (p.x - c.x) * (q.y - c.y) - (p.y - c.y) * (q.x - c.x) >= 0;
    return layoutCurvedStair(c, radius, a0, ccw, steps, drawGoing(state), baseZ, topZ);
  }
  return layoutStair(points, width, steps, baseZ, topZ, windersPerTurn(da));
}

/** Preview of the stair being drawn: complete once the clicks + cursor are enough (a U mirrors its first run until the last click). */
function previewLayout(state: ToolStateSnapshot, pts: Point[]): StairLayout | null {
  const need = clicksRequired(state.drawingAttrs.stair_type);
  if (need <= 2) return null;
  if (pts.length === need) return stairLayoutFor(state, pts);
  if (state.drawingAttrs.stair_type === 'half_turn' && pts.length === 3) {
    return stairLayoutFor(state, [...pts, { x: pts[2].x + pts[0].x - pts[1].x, y: pts[2].y + pts[0].y - pts[1].y }]);
  }
  return null;
}

const num = (s: string | undefined, fallback: number) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Level-relative rise of the stair being drawn: base_offset → top level + top_offset. */
export function stairSpan(state: Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs'>): { baseZ: number; topZ: number } {
  const da = state.drawingAttrs;
  const levels = state.project?.levels ?? [];
  const curId = state.document?.levelId ?? '';
  const curElev = levels.find(l => l.id === curId)?.elevation ?? 0;
  const baseZ = num(da.base_offset, 0);
  const topLevel = levels.find(l => l.id === (da.top_level_id || curId));
  let topZ = (topLevel?.elevation ?? curElev) - curElev + num(da.top_offset, 0);
  if (topZ - baseZ < 1e-6) topZ = baseZ + 3;
  return { baseZ, topZ };
}

function placeStair(ctx: ToolContext, state: ToolStateSnapshot, points: Point[]) {
  const da = state.drawingAttrs;
  const width = num(da.width, 1.2) || 1.2;
  const layout = stairLayoutFor(state, points);
  if (!layout) return;
  // Turning by winders makes it a winder stair (IfcStairTypeEnum *_WINDING)
  const stairType = layout.landings.some(l => l.steps) ? 'winder' : da.stair_type;
  const levelId = state.document?.levelId ?? '';
  const elements = stairElements({
    layout,
    existingIds: state.document?.elements.keys() ?? [],
    levelId,
    attrs: { ...defaultAttrs('stair', resolveNextLevelId(state)), ...da, ...(stairType ? { stair_type: stairType } : {}) },
    width,
    railings: da[STAIR_RAILINGS_KEY],
  });
  ctx.dispatch({ type: 'CREATE_ELEMENTS', elements, description: 'Place stair' });
}
