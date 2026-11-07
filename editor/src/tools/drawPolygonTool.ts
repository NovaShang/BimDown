import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import { pointInPolygon, signedArea } from '../geometry/roofSolver.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { getProjectUnits } from '../utils/units.ts';
import { placementTypeForTable } from '../model/tableRegistry.ts';

/** Minimum 3 vertices to form a polygon */
const MIN_VERTICES = 3;
/** Distance in SVG units to auto-close polygon when clicking near start */
const CLOSE_DISTANCE = 0.5;

export const drawPolygonTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points || [];
    const anchor = points.length > 0 ? points[points.length - 1] : undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, points, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;
    ctx.setSnap(snap);

    // Check if closing the polygon (click near first point)
    if (points.length >= MIN_VERTICES) {
      const first = points[0];
      const dx = pt.x - first.x;
      const dy = pt.y - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < CLOSE_DISTANCE) {
        createPolygon(ctx.getState(), ctx.dispatch, points);
        ctx.setSnap(null);
        return;
      }
    }

    // Add vertex
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [...points, pt], cursor: pt },
    });
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const points = state.drawingState?.points || [];
    const anchor = points.length > 0 ? points[points.length - 1] : undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, points, undefined, getProjectUnits(state), state.disabledSnapTypes);
    const pt = snap.point;

    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points, cursor: pt },
    });
    ctx.setSnap(snap);
  },
};

/** The active tool is drawing a polygon outline (slab, roof, ceiling, …). */
export function isDrawingPolygon(state: { activeTool: string; drawingTarget: { tableName: string; variantId?: string } | null }): boolean {
  if (state.activeTool === 'draw_polygon') return true;
  return state.activeTool === 'draw' && !!state.drawingTarget
    && placementTypeForTable(state.drawingTarget.tableName) === 'free_polygon';
}

/**
 * Close the polygon being drawn (right-click / Enter). Returns false when
 * fewer than 3 vertices are placed, so the caller can fall back to cancel.
 */
export function finishPolygon(
  state: Pick<ToolStateSnapshot, 'drawingTarget' | 'drawingAttrs' | 'drawingState' | 'document' | 'project' | 'currentLevel'>,
  dispatch: (action: EditorAction) => void,
): boolean {
  const points = state.drawingState?.points ?? [];
  if (!state.drawingTarget || points.length < MIN_VERTICES) return false;
  createPolygon(state, dispatch, points);
  return true;
}

const OPENING_HOSTS = new Set(['slab', 'structure_slab', 'roof']);

/**
 * Attrs of a sketched polygon opening: hosted on the smallest floor / roof of
 * the level containing its centre, or a shaft (top_level_id) needing no host.
 * Wall-opening fields are dropped. Null when a non-shaft has no host.
 */
export function polygonOpeningAttrs(
  attrs: Record<string, string>,
  vertices: { x: number; y: number }[],
  elements: ReadonlyMap<string, CanonicalElement> | undefined,
  shaft: boolean,
): Record<string, string> | null {
  const out = { ...attrs };
  for (const k of ['position', 'width', 'height', 'shape']) out[k] = '';
  let cx = 0, cy = 0;
  for (const v of vertices) { cx += v.x; cy += v.y; }
  cx /= vertices.length; cy /= vertices.length;
  let host: PolygonElement | null = null, hostArea = Infinity;
  for (const el of elements?.values() ?? []) {
    if (!OPENING_HOSTS.has(el.tableName) || el.geometry !== 'polygon') continue;
    if (!pointInPolygon({ x: cx, y: cy }, el.vertices)) continue;
    const a = Math.abs(signedArea(el.vertices));
    if (a < hostArea) { host = el; hostArea = a; }
  }
  if (shaft) {
    out.host_id = host?.id ?? '';
    if (!out.top_level_id) return null;
    return out;
  }
  if (!host) return null;
  out.host_id = host.id;
  out.top_level_id = '';
  out.top_offset = '';
  out.base_offset = '';
  return out;
}

function createPolygon(
  state: Pick<ToolStateSnapshot, 'drawingTarget' | 'drawingAttrs' | 'document' | 'project' | 'currentLevel'>,
  dispatch: (action: EditorAction) => void,
  vertices: { x: number; y: number }[],
) {
  const target = state.drawingTarget;
  if (!target) return;

  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId(target.tableName, existingIds);
  const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
  const vDefaults = variantDefaults(target.tableName, target.variantId);
  let mergedAttrs: Record<string, string> = { ...baseAttrs, ...vDefaults, ...state.drawingAttrs, id };
  if (target.tableName === 'opening') {
    const attrs = polygonOpeningAttrs(mergedAttrs, vertices, state.document?.elements, target.variantId === 'shaft');
    if (!attrs) return; // a sketched opening needs a floor or roof under it
    mergedAttrs = attrs;
  }

  const element: PolygonElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'polygon',
    vertices,
    attrs: mergedAttrs,
  };

  dispatch({ type: 'CREATE_ELEMENT', element });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}
