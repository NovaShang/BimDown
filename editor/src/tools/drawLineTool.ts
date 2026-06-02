import type { ToolHandler, ToolContext } from './types.ts';
import type { CanonicalElement, LineElement, SpatialLineElement } from '../model/elements.ts';
import { geometryTypeForTable } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { drawStairTool, isMultiClickStair } from './drawStairTool.ts';
import { variantDefaults } from './variantDefaults.ts';
import { gatherConnectorSnapPoints, isMepLineTable } from '../utils/connectorSnap.ts';

/** When true, the multi-click stair placement tool handles this event instead
 *  of the regular line-creation flow. Straight stairs and every other table
 *  still go through the line path unchanged. */
function shouldDelegateToStairTool(state: { drawingTarget: { tableName: string } | null; drawingAttrs: Record<string, string> }): boolean {
  return state.drawingTarget?.tableName === 'stair'
    && isMultiClickStair(state.drawingAttrs.stair_type);
}

/** Reserved drawingAttrs key (double underscore prefix to avoid CSV-field collision)
 *  enabling single-click vertical-pipe placement for MEP topo-line elements. */
export const VERTICAL_MODE_KEY = '__vertical_mode';

function isVerticalMode(attrs: Record<string, string>): boolean {
  return attrs[VERTICAL_MODE_KEY] === 'true';
}

export const drawLineTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    // Stair tool intercept: L / U / multi-click stair shapes use a dedicated
    // tool that lays down stair + stair_landing + stair_run in one placement.
    if (shouldDelegateToStairTool(ctx.getState())) {
      drawStairTool.onPointerDown?.(ctx, e);
      return;
    }

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const connectors = isMepLineTable(state.drawingTarget?.tableName)
      ? gatherConnectorSnapPoints(state.document?.elements)
      : undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, connectors, getProjectUnits(state));
    const pt = snap.point;
    ctx.setSnap(snap);

    // Vertical placement: single-click → create a spatial_line at start.xy == end.xy
    // using start_z / end_z from drawingAttrs. Only valid for spatial_line geometry.
    if (isVerticalMode(state.drawingAttrs)) {
      const target = state.drawingTarget;
      if (!target) return;
      if (geometryTypeForTable(target.tableName) !== 'spatial_line') return;
      createVerticalElement(ctx, state, target, pt);
      return;
    }

    const points = state.drawingState?.points || [];

    if (points.length === 0) {
      // First click — set start point, remember the connector's port ref
      // (if the cursor landed on one) so it can later go into pipe.from.
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [pt], cursor: pt, startPortRef: snap.connectorHit?.portRef },
      });
    } else {
      // Second click — create element
      const target = state.drawingTarget;
      if (!target) return;

      const start = points[0];
      const end = pt;

      const existingIds = new Set(state.document?.elements.keys() ?? []);
      const id = generateId(target.tableName, existingIds);
      const da = state.drawingAttrs;

      // Resolve strokeWidth: walls use 'thickness', ducts/pipes use 'size_x'
      const strokeWidth = resolveLineStrokeWidth(target.tableName, da) ?? FALLBACK_STROKE[target.tableName] ?? 0.1;

      // Merge drawingAttrs into element attrs
      const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
      const vDefaults = variantDefaults(target.tableName, target.variantId);
      const mergedAttrs: Record<string, string> = { ...baseAttrs, ...vDefaults, ...da, id };
      // Strip the reserved UI flag from the persisted attrs.
      delete mergedAttrs[VERTICAL_MODE_KEY];

      // Connector wiring: when the user dropped the start or end on a
      // connector port, attach `from` / `to` to the connector's port-ref
      // ("host_id:port_name" or bare host_id) so the reverse-topology cascade
      // (host move → line endpoint move) keeps the line glued to the
      // equipment. Only applies to MEP line tables.
      if (isMepLineTable(target.tableName)) {
        const startRef = state.drawingState?.startPortRef;
        const endRef = snap.connectorHit?.portRef;
        if (startRef) mergedAttrs.from = startRef;
        if (endRef) mergedAttrs.to = endRef;
      }

      const geo = geometryTypeForTable(target.tableName);
      const element: CanonicalElement = geo === 'spatial_line'
        ? {
            id,
            tableName: target.tableName,
            discipline: target.discipline,
            geometry: 'spatial_line',
            start,
            end,
            startZ: parseFloat(da.start_z ?? '0'),
            endZ: parseFloat(da.end_z ?? '0'),
            strokeWidth,
            attrs: mergedAttrs,
          } satisfies SpatialLineElement
        : {
            id,
            tableName: target.tableName,
            discipline: target.discipline,
            geometry: 'line',
            start,
            end,
            strokeWidth,
            attrs: mergedAttrs,
          } satisfies LineElement;

      ctx.dispatch({ type: 'CREATE_ELEMENT', element });
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
      ctx.setSnap(null);
    }
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (shouldDelegateToStairTool(ctx.getState())) {
      drawStairTool.onPointerMove?.(ctx, e);
      return;
    }

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const anchor = state.drawingState?.points[0] ?? undefined;
    const connectors = isMepLineTable(state.drawingTarget?.tableName)
      ? gatherConnectorSnapPoints(state.document?.elements)
      : undefined;
    const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, connectors, getProjectUnits(state));
    const pt = snap.point;

    if (isVerticalMode(state.drawingAttrs)) {
      // Vertical mode: keep cursor preview alive even without a placed start point.
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [], cursor: pt },
      });
    } else if (state.drawingState && state.drawingState.points.length > 0) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { ...state.drawingState, cursor: pt },
      });
    }
    ctx.setSnap(snap);
  },
};

function createVerticalElement(
  ctx: ToolContext,
  state: ReturnType<ToolContext['getState']>,
  target: { tableName: string; discipline: string; variantId?: string },
  pt: { x: number; y: number },
) {
  const existingIds = new Set(state.document?.elements.keys() ?? []);
  const id = generateId(target.tableName, existingIds);
  const da = state.drawingAttrs;
  const strokeWidth = resolveLineStrokeWidth(target.tableName, da) ?? FALLBACK_STROKE[target.tableName] ?? 0.1;
  const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
  const vDefaults = variantDefaults(target.tableName, target.variantId);
  const mergedAttrs: Record<string, string> = { ...baseAttrs, ...vDefaults, ...da, id };
  // Strip the reserved UI flag from the persisted attrs.
  delete mergedAttrs[VERTICAL_MODE_KEY];

  let startZ = parseFloat(da.start_z ?? baseAttrs.start_z ?? '0');
  let endZ = parseFloat(da.end_z ?? baseAttrs.end_z ?? '0');
  if (!isFinite(startZ)) startZ = 0;
  if (!isFinite(endZ)) endZ = 0;
  // Fall back to ±1m around start_z if start_z == end_z so the pipe is visible.
  if (Math.abs(endZ - startZ) < 1e-6) {
    endZ = startZ + 1;
  }

  const element: SpatialLineElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'spatial_line',
    start: pt,
    end: pt,
    startZ,
    endZ,
    strokeWidth,
    attrs: mergedAttrs,
  };

  ctx.dispatch({ type: 'CREATE_ELEMENT', element });
  // Keep vertical mode active; just clear the drawing scratch state.
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: pt } });
  ctx.setSnap(null);
}

const FALLBACK_STROKE: Record<string, number> = {
  wall: 0.2, curtain_wall: 0.05, structure_wall: 0.2,
  duct: 0.2, pipe: 0.05, conduit: 0.025, cable_tray: 0.1,
  door: 0.1, window: 0.1,
};
