import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
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

/** Get the current level's elevation from project data. */
function getLevelElevation(state: ToolStateSnapshot): number {
  if (!state.project) return 0;
  const level = state.project.levels.find(l => l.id === state.currentLevel);
  return level?.elevation ?? 0;
}

/** Compute base_offset from wall elevation raycast. Doors lock to 0. */
function computeBaseOffset(
  ctx: ToolContext,
  e: React.PointerEvent,
  wall: LineElement,
  tableName: string,
  elementHeight: number,
  levelElevation: number,
): number {
  // Doors always sit on the floor
  if (tableName === 'door') return 0;

  if (!ctx.screenToWallElevation) return 0;

  const elevation = ctx.screenToWallElevation(e.clientX, e.clientY, wall.start, wall.end);
  if (elevation == null) return 0;

  // base_offset = cursor elevation - level elevation - half element height (center cursor on element)
  const raw = elevation - levelElevation - elementHeight / 2;
  // Clamp: at least 0, at most wallHeight - elementHeight (approximate)
  return Math.max(0, Math.round(raw * 100) / 100);
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

    // Compute base_offset from cursor elevation
    const levelElevation = getLevelElevation(state);
    const elementHeight = parseFloat(da.height || baseAttrs.height || '2.1');
    const baseOffset = computeBaseOffset(ctx, e, hit.wall, target.tableName, elementHeight, levelElevation);

    const mergedAttrs = { ...baseAttrs, ...da, id, host_id: hit.wall.id, position, base_offset: String(baseOffset) };

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

      // Compute base_offset from cursor elevation
      const levelElevation = getLevelElevation(state);
      const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
      const elementHeight = parseFloat(da.height || baseAttrs.height || '2.1');
      const baseOffset = computeBaseOffset(ctx, e, hit.wall, target.tableName, elementHeight, levelElevation);

      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [start], cursor: end, baseOffset },
      });
    } else {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [], cursor: svgPt },
      });
    }
  },
};
