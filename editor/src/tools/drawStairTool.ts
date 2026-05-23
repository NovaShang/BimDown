/**
 * Multi-click stair placement tool.
 *
 * Click sequence depends on `drawingAttrs.stair_type`:
 *   - straight                              → 2 clicks (delegates to drawLineTool path)
 *   - quarter_turn (L)                      → 3 clicks: start, corner, end
 *                                              Emits: stair (start→corner)
 *                                                   + stair_landing (square at corner)
 *                                                   + stair_run (corner→end)
 *   - half_turn (U)                         → 4 clicks: start, mid1, mid2, end
 *                                              Emits: stair (start→mid1)
 *                                                   + stair_landing (rect mid1→mid2)
 *                                                   + stair_run (mid2→end)
 *   - winder / spiral / curved / double_return
 *                                           → TODO: richer math needed.
 *                                             For this round we fall back to the
 *                                             2-click straight placement.
 *
 * Z range: total rise (end_z - start_z, drawingAttrs) is split evenly across runs.
 * step_count is split evenly across runs as well.
 * All children carry host_id = parent stair's id (level-scoped, no prefix).
 *
 * The tool is invoked from drawLineTool when target.tableName === 'stair' AND
 * the stair_type drawingAttr requires more than 2 clicks. The straight case
 * passes through to the regular line-creation path so the existing 2-click
 * behavior is preserved exactly.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type {
  CanonicalElement, SpatialLineElement, PolygonElement, Point,
} from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';

/** Stair types that need more than 2 clicks. Everything else falls back to
 *  straight 2-click placement. */
export function clicksRequired(stairType: string | undefined): number {
  switch (stairType) {
    case 'quarter_turn': return 3;
    case 'half_turn':    return 4;
    // straight / winder / spiral / curved / double_return → 2-click fallback
    default:             return 2;
  }
}

/** True when the active stair_type calls for the multi-click path. */
export function isMultiClickStair(stairType: string | undefined): boolean {
  return clicksRequired(stairType) > 2;
}

export const drawStairTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points ?? [];
    const anchor = points.length > 0 ? points[points.length - 1] : undefined;
    const snap = snapPoint(
      svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids,
    );
    const pt = snap.point;
    ctx.setSnap(snap);

    const stairType = state.drawingAttrs.stair_type;
    const need = clicksRequired(stairType);

    const nextPoints = [...points, pt];

    if (nextPoints.length < need) {
      // Still gathering clicks — record point and wait.
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: nextPoints, cursor: pt },
      });
      return;
    }

    // We have all the points we need — commit.
    if (need === 3 && stairType === 'quarter_turn') {
      placeQuarterTurn(ctx, state, nextPoints[0], nextPoints[1], nextPoints[2]);
    } else if (need === 4 && stairType === 'half_turn') {
      placeHalfTurn(ctx, state, nextPoints[0], nextPoints[1], nextPoints[2], nextPoints[3]);
    } else {
      // Shouldn't reach here — straight cases are dispatched from drawLineTool.
      // Guard with a 2-click straight fallback so the placement isn't lost.
      placeStraight(ctx, state, nextPoints[0], nextPoints[nextPoints.length - 1]);
    }

    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;
    const state = ctx.getState();
    const points = state.drawingState?.points ?? [];
    const anchor = points.length > 0 ? points[points.length - 1] : undefined;
    const snap = snapPoint(
      svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids,
    );
    const pt = snap.point;
    if (points.length > 0) {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points, cursor: pt } });
    } else {
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: pt } });
    }
    ctx.setSnap(snap);
  },
};

// ─── placement helpers ─────────────────────────────────────────────────────

interface PlacementParams {
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  levelId: string;
  baseStair: Record<string, string>;
}

function readPlacementParams(state: ToolStateSnapshot): PlacementParams {
  const da = state.drawingAttrs;
  const levelId = resolveNextLevelId(state);
  const baseStair = defaultAttrs('stair', levelId);
  const startZ = parseFloatSafe(da.start_z ?? baseStair.start_z, 0);
  let endZ   = parseFloatSafe(da.end_z   ?? baseStair.end_z,   3);
  if (Math.abs(endZ - startZ) < 1e-6) endZ = startZ + 3;
  const width = parseFloatSafe(da.width ?? baseStair.width, 1.2);
  const stepCount = Math.max(2, Math.round(parseFloatSafe(da.step_count ?? baseStair.step_count, 18)));
  return { startZ, endZ, width, stepCount, levelId, baseStair };
}

function parseFloatSafe(s: string | undefined, fallback: number): number {
  const v = parseFloat(s ?? '');
  return isFinite(v) ? v : fallback;
}

function placeStraight(ctx: ToolContext, state: ToolStateSnapshot, start: Point, end: Point) {
  const params = readPlacementParams(state);
  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId('stair', existingIds);
  existingIds.add(id);
  const stair = buildStair(id, start, end, params, state.drawingAttrs, params.startZ, params.endZ, params.stepCount);
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: stair });
}

function placeQuarterTurn(
  ctx: ToolContext, state: ToolStateSnapshot,
  start: Point, corner: Point, end: Point,
) {
  const params = readPlacementParams(state);
  const existingIds = new Set(state.document?.elements.keys() ?? []);

  // Split rise + steps evenly across 2 runs.
  const totalRise = params.endZ - params.startZ;
  const midZ = params.startZ + totalRise / 2;
  const stepsPerRun = Math.max(1, Math.floor(params.stepCount / 2));

  // Parent stair (first run): start → corner
  const stairId = generateId('stair', existingIds);
  existingIds.add(stairId);
  const stair = buildStair(
    stairId, start, corner, params, state.drawingAttrs,
    params.startZ, midZ, stepsPerRun,
  );
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: stair });

  // Landing at the corner — square of side `width`, oriented to the bisector
  // of the incoming and outgoing directions.
  const landingId = generateId('stair_landing', existingIds);
  existingIds.add(landingId);
  const landing = buildLanding(landingId, stairId, corner, corner, start, end, params);
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: landing });

  // Second run: corner → end. Note: step_count for the run is for the run,
  // not cumulative. stair_run has no top_level_id / stair_type fields.
  const runId = generateId('stair_run', existingIds);
  existingIds.add(runId);
  const run = buildRun(
    runId, stairId, corner, end, params, state.drawingAttrs,
    midZ, params.endZ, params.stepCount - stepsPerRun,
  );
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: run });
}

function placeHalfTurn(
  ctx: ToolContext, state: ToolStateSnapshot,
  start: Point, mid1: Point, mid2: Point, end: Point,
) {
  const params = readPlacementParams(state);
  const existingIds = new Set(state.document?.elements.keys() ?? []);

  const totalRise = params.endZ - params.startZ;
  const midZ = params.startZ + totalRise / 2;
  const stepsPerRun = Math.max(1, Math.floor(params.stepCount / 2));

  // Parent stair (first run): start → mid1
  const stairId = generateId('stair', existingIds);
  existingIds.add(stairId);
  const stair = buildStair(
    stairId, start, mid1, params, state.drawingAttrs,
    params.startZ, midZ, stepsPerRun,
  );
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: stair });

  // Landing spans mid1 → mid2. Footprint: rectangle oriented along the
  // mid1→mid2 axis with depth = width (square cross-section).
  const landingId = generateId('stair_landing', existingIds);
  existingIds.add(landingId);
  const landing = buildLanding(landingId, stairId, mid1, mid2, start, end, params);
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: landing });

  // Second run: mid2 → end
  const runId = generateId('stair_run', existingIds);
  existingIds.add(runId);
  const run = buildRun(
    runId, stairId, mid2, end, params, state.drawingAttrs,
    midZ, params.endZ, params.stepCount - stepsPerRun,
  );
  ctx.dispatch({ type: 'CREATE_ELEMENT', element: run });
}

// ─── element factories ─────────────────────────────────────────────────────

function buildStair(
  id: string, start: Point, end: Point,
  params: PlacementParams, drawingAttrs: Record<string, string>,
  startZ: number, endZ: number, stepCount: number,
): SpatialLineElement {
  const merged = {
    ...params.baseStair,
    ...drawingAttrs,
    id,
    start_z: String(startZ),
    end_z: String(endZ),
    width: String(params.width),
    step_count: String(stepCount),
  };
  return {
    id,
    tableName: 'stair',
    discipline: 'architecture',
    geometry: 'spatial_line',
    start, end,
    startZ, endZ,
    strokeWidth: params.width,
    attrs: merged,
  };
}

function buildRun(
  id: string, hostId: string, start: Point, end: Point,
  params: PlacementParams, _drawingAttrs: Record<string, string>,
  startZ: number, endZ: number, stepCount: number,
): SpatialLineElement {
  const base = defaultAttrs('stair_run', params.levelId);
  const merged = {
    ...base,
    id,
    host_id: hostId,
    start_z: String(startZ),
    end_z: String(endZ),
    width: String(params.width),
    step_count: String(stepCount),
  };
  return {
    id,
    tableName: 'stair_run',
    discipline: 'architecture',
    geometry: 'spatial_line',
    start, end,
    startZ, endZ,
    strokeWidth: params.width,
    attrs: merged,
  };
}

/**
 * Build the stair_landing polygon.
 *
 * Two flavors:
 *   - cornerLike (a == b, the L-shape case): square of side `width` centered
 *     at the corner, oriented along the bisector of the incoming/outgoing
 *     run directions.
 *   - spanLike (a != b, the U-shape case): rectangle whose long axis is the
 *     a→b segment, with depth = width.
 *
 * `runStart` / `runEnd` are only used for the corner case to compute the
 * bisector — for the span case the axis is given by a→b directly.
 */
function buildLanding(
  id: string, hostId: string,
  a: Point, b: Point,
  runStart: Point, runEnd: Point,
  params: PlacementParams,
): PolygonElement {
  const w = params.width;
  let vertices: Point[];

  const dx = b.x - a.x, dy = b.y - a.y;
  const span = Math.sqrt(dx * dx + dy * dy);

  if (span < 1e-6) {
    // Corner landing — square aligned to bisector of incoming/outgoing dirs.
    // Incoming = a - runStart, outgoing = runEnd - a.
    const inDx = a.x - runStart.x, inDy = a.y - runStart.y;
    const outDx = runEnd.x - a.x, outDy = runEnd.y - a.y;
    const inLen = Math.hypot(inDx, inDy) || 1;
    const outLen = Math.hypot(outDx, outDy) || 1;
    const ix = inDx / inLen, iy = inDy / inLen;
    const ox = outDx / outLen, oy = outDy / outLen;
    // Bisector axis = normalize(in + out). Fall back to incoming dir if degenerate.
    let bx = ix + ox, by = iy + oy;
    let blen = Math.hypot(bx, by);
    if (blen < 1e-6) { bx = ix; by = iy; blen = 1; }
    bx /= blen; by /= blen;
    const nx = -by, ny = bx;
    const hw = w / 2;
    vertices = [
      { x: a.x + bx * hw + nx * hw, y: a.y + by * hw + ny * hw },
      { x: a.x + bx * hw - nx * hw, y: a.y + by * hw - ny * hw },
      { x: a.x - bx * hw - nx * hw, y: a.y - by * hw - ny * hw },
      { x: a.x - bx * hw + nx * hw, y: a.y - by * hw + ny * hw },
    ];
  } else {
    // Span landing — rectangle along a→b, depth = width.
    const ux = dx / span, uy = dy / span;
    const nx = -uy, ny = ux;
    const hw = w / 2;
    vertices = [
      { x: a.x + nx * hw, y: a.y + ny * hw },
      { x: b.x + nx * hw, y: b.y + ny * hw },
      { x: b.x - nx * hw, y: b.y - ny * hw },
      { x: a.x - nx * hw, y: a.y - ny * hw },
    ];
  }

  // Landing sits at the level of the joining run's top: midZ for L/U stairs.
  // We use the average of the two adjoining heights to keep this simple.
  const totalRise = params.endZ - params.startZ;
  const midZ = params.startZ + totalRise / 2;

  const base = defaultAttrs('stair_landing', params.levelId);
  const merged = {
    ...base,
    id,
    host_id: hostId,
    base_offset: String(midZ),
  };

  const element: PolygonElement = {
    id,
    tableName: 'stair_landing',
    discipline: 'architecture',
    geometry: 'polygon',
    vertices,
    attrs: merged,
  };
  return element;
}

/** Re-exported for the dispatcher in drawLineTool. */
export type { CanonicalElement };
