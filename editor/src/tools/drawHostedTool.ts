import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { hostTablesFor, widthAttrFor, isHostedTable } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { nearestPointOnSegment } from '../utils/snap.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { resolveHostedGeometry, computeHostedPosition } from '../model/hosted.ts';

const HOST_SNAP_THRESHOLD = 1; // metres — max distance from cursor to wall centerline

interface HostHit {
  wall: LineElement;
  /** Parameter along wall (0 = start, 1 = end) */
  t: number;
}

/** Find the nearest host wall to a 2D cursor point (floor-plane fallback). */
function findNearestHost(
  cursor: Point,
  elements: ReadonlyMap<string, CanonicalElement>,
  hostTables: Set<string>,
): HostHit | null {
  let best: { wall: LineElement; t: number; dist: number } | null = null;

  for (const el of elements.values()) {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if (!hostTables.has(el.tableName)) continue;
    const wall = el as LineElement;
    const { start, end } = wall;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) continue;

    const wallLen = Math.sqrt(lenSq);
    const tMeters = Math.max(0, Math.min(wallLen, ((cursor.x - start.x) * dx + (cursor.y - start.y) * dy) / lenSq * wallLen));
    const projected = nearestPointOnSegment(cursor, start, end);
    const ddx = cursor.x - projected.x;
    const ddy = cursor.y - projected.y;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);

    if (dist < HOST_SNAP_THRESHOLD && (!best || dist < best.dist)) {
      best = { wall, t: tMeters, dist };
    }
  }
  return best;
}

/** Find a host wall by element ID (for 3D scene raycast results). */
function findHostById(
  elementId: string,
  elements: ReadonlyMap<string, CanonicalElement>,
  hostTables: Set<string>,
): LineElement | null {
  // Element IDs from 3D scene are prefixed with "levelId:" — strip prefix
  const rawId = elementId.includes(':') ? elementId.slice(elementId.indexOf(':') + 1) : elementId;
  const el = elements.get(rawId);
  if (!el) return null;
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  if (!hostTables.has(el.tableName)) return null;
  return el as LineElement;
}

/** Get the current level's elevation from project data. */
function getLevelElevation(state: ToolStateSnapshot): number {
  if (!state.project) return 0;
  const level = state.project.levels.find(l => l.id === state.currentLevel);
  return level?.elevation ?? 0;
}

interface HostedPlacement {
  start: Point;
  end: Point;
  t: number;
  baseOffset: number;
  wall: LineElement;
}

/**
 * Resolve hosted element placement from screen position.
 * Strategy:
 * 1. Try 3D scene raycast (screenToScenePoint) — directly hits wall mesh, gives exact position + elevation
 * 2. Fall back to floor-plane raycast (screenToSvg + findNearestHost) for 2D mode
 */
function resolveHostedPlacement(
  ctx: ToolContext,
  e: React.PointerEvent,
  state: ToolStateSnapshot,
  hostTables: Set<string>,
  tableName: string,
  width: number,
  elementHeight: number,
  levelElevation: number,
): HostedPlacement | null {
  const elements = state.document?.elements;
  if (!elements) return null;

  // Try 3D scene raycast first — directly hit a wall mesh
  const sceneHit = ctx.screenToScenePoint?.(e.clientX, e.clientY);
  if (sceneHit) {
    const wall = findHostById(sceneHit.elementId, elements, hostTables);
    if (wall) {
      const cursorOnWall: Point = { x: sceneHit.x, y: sceneHit.y };
      const t = computeHostedPosition(wall, cursorOnWall);
      const { start, end } = resolveHostedGeometry(wall, t, width);

      let baseOffset = 0;
      if (tableName !== 'door') {
        const raw = sceneHit.elevation - levelElevation - elementHeight / 2;
        baseOffset = Math.max(0, Math.round(raw * 100) / 100);
      }

      return { start, end, t, baseOffset, wall };
    }
  }

  // Fallback: floor-plane raycast (2D mode or no wall hit in 3D)
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;

  const hit = findNearestHost(svgPt, elements, hostTables);
  if (!hit) return null;

  const { start, end } = resolveHostedGeometry(hit.wall, hit.t, width);
  return { start, end, t: hit.t, baseOffset: 0, wall: hit.wall };
}

export const drawHostedTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;

    if (!isHostedTable(target.tableName)) return;
    const tables = hostTablesFor(target.tableName);
    const wAttr = widthAttrFor(target.tableName);

    const da = state.drawingAttrs;
    const width = parseFloat(da[wAttr] || '0.9');
    const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const elementHeight = parseFloat(da.height || baseAttrs.height || '2.1');
    const levelElevation = getLevelElevation(state);

    const placement = resolveHostedPlacement(ctx, e, state, tables, target.tableName, width, elementHeight, levelElevation);
    if (!placement) return;

    const elements = state.document?.elements;
    if (!elements) return;

    const existingIds = new Set(elements.keys());
    const id = generateId(target.tableName, existingIds);
    const position = placement.t.toFixed(3);

    const mergedAttrs = { ...baseAttrs, ...da, id, host_id: placement.wall.id, position, base_offset: String(placement.baseOffset) };

    const element: LineElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'line',
      start: placement.start,
      end: placement.end,
      strokeWidth: 0.1,
      attrs: mergedAttrs,
      hostId: placement.wall.id,
      locationParam: placement.t,
    };

    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;

    if (!isHostedTable(target.tableName)) return;
    const tables = hostTablesFor(target.tableName);
    const wAttr = widthAttrFor(target.tableName);

    const da = state.drawingAttrs;
    const width = parseFloat(da[wAttr] || '0.9');
    const baseAttrs = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const elementHeight = parseFloat(da.height || baseAttrs.height || '2.1');
    const levelElevation = getLevelElevation(state);

    const placement = resolveHostedPlacement(ctx, e, state, tables, target.tableName, width, elementHeight, levelElevation);

    if (placement) {
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [placement.start], cursor: placement.end, baseOffset: placement.baseOffset },
      });
    } else {
      const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
      ctx.dispatch({
        type: 'SET_DRAWING_STATE',
        state: { points: [], cursor: svgPt ?? { x: 0, y: 0 } },
      });
    }
  },
};
