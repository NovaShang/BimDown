import type { ToolHandler, ToolContext } from './types.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { HOSTED_TABLES } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { nearestPointOnSegment } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';

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
    if (el.geometry !== 'line') continue;
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

/** Compute door/window start & end on the wall centerline, centered at the projected point. */
function computeHostedSpan(
  hit: HostHit,
  width: number,
): { start: Point; end: Point } {
  const { wall, t } = hit;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 1e-10) return { start: hit.projected, end: hit.projected };

  // Unit direction along wall
  const ux = dx / wallLen;
  const uy = dy / wallLen;

  // Center position along wall (in metres from wall start)
  const center = t * wallLen;
  const half = width / 2;

  // Clamp so the door/window doesn't extend beyond wall endpoints
  const lo = Math.max(0, Math.min(wallLen - width, center - half));
  const hi = lo + width;

  return {
    start: { x: wall.start.x + ux * lo, y: wall.start.y + uy * lo },
    end:   { x: wall.start.x + ux * hi, y: wall.start.y + uy * hi },
  };
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

    const config = HOSTED_TABLES[target.tableName];
    if (!config) return;

    const elements = state.document?.elements;
    if (!elements) return;

    const hit = findNearestHost(svgPt, elements, config.hostTables);
    if (!hit) return;

    const da = state.drawingAttrs;
    const width = parseFloat(da[config.widthAttr] || '0.9');
    const { start, end } = computeHostedSpan(hit, width);

    const existingIds = new Set(elements.keys());
    const id = generateId(target.tableName, existingIds);

    const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const mergedAttrs = { ...baseAttrs, ...da, id, host_id: hit.wall.id };

    const element: LineElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'line',
      start,
      end,
      strokeWidth: 0.1,
      attrs: mergedAttrs,
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

    const config = HOSTED_TABLES[target.tableName];
    if (!config) return;

    const elements = state.document?.elements;
    if (!elements) return;

    const hit = findNearestHost(svgPt, elements, config.hostTables);

    if (hit) {
      const da = state.drawingAttrs;
      const width = parseFloat(da[config.widthAttr] || '0.9');
      const { start, end } = computeHostedSpan(hit, width);
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
