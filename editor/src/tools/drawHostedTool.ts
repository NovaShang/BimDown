import type { ToolHandler, ToolContext } from './types.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { hostTablesFor, widthAttrFor, isHostedTable } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { nearestPointOnSegment } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { resolveHostedGeometry } from '../model/hosted.ts';

const HOST_SNAP_THRESHOLD = 1; // metres — max distance from cursor to wall centerline

interface HostHit {
  wall: LineElement;
  /** Projected point on wall centerline */
  projected: Point;
  /** Distance from cursor to projected point */
  dist: number;
  /** Parameter along wall (0 = start, 1 = end) */
  t: number;
}

function findNearestHost(
  cursor: Point,
  elements: ReadonlyMap<string, CanonicalElement>,
  hostTables: Set<string>,
): HostHit | null {
  let best: HostHit | null = null;

  for (const el of elements.values()) {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if (!hostTables.has(el.tableName)) continue;
    const wall = el as LineElement;
    const { start, end } = wall;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) continue;

    // Parameter along wall segment (clamped 0–1)
    const t = Math.max(0, Math.min(1, ((cursor.x - start.x) * dx + (cursor.y - start.y) * dy) / lenSq));
    const projected = nearestPointOnSegment(cursor, start, end);
    const ddx = cursor.x - projected.x;
    const ddy = cursor.y - projected.y;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);

    if (dist < HOST_SNAP_THRESHOLD && (!best || dist < best.dist)) {
      best = { wall, projected, dist, t };
    }
  }
  return best;
}


export const drawHostedTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;

    if (!isHostedTable(target.tableName)) return;
    const tables = hostTablesFor(target.tableName);
    const wAttr = widthAttrFor(target.tableName);

    const elements = state.document?.elements;
    if (!elements) return;

    const hit = findNearestHost(svgPt, elements, tables);
    if (!hit) return;

    const da = state.drawingAttrs;
    const width = parseFloat(da[wAttr] || '0.9');
    const { start, end } = resolveHostedGeometry(hit.wall, hit.t, width);

    const existingIds = new Set(elements.keys());
    const id = generateId(target.tableName, existingIds);

    const position = hit.t.toFixed(4);
    const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const mergedAttrs = { ...baseAttrs, ...da, id, host_id: hit.wall.id, position };

    const element: LineElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'line',
      start,
      end,
      strokeWidth: 0.1,
      attrs: mergedAttrs,
      hostId: hit.wall.id,
      locationParam: hit.t,
    };

    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;

    if (!isHostedTable(target.tableName)) return;
    const tables = hostTablesFor(target.tableName);
    const wAttr = widthAttrFor(target.tableName);

    const elements = state.document?.elements;
    if (!elements) return;

    const hit = findNearestHost(svgPt, elements, tables);

    if (hit) {
      const da = state.drawingAttrs;
      const width = parseFloat(da[wAttr] || '0.9');
      const { start, end } = resolveHostedGeometry(hit.wall, hit.t, width);
      // Store preview span as points[0] = start, cursor = end
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [start], cursor: end },
      });
    } else {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [], cursor: svgPt },
      });
    }
  },
};
