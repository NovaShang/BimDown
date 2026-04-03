import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { hostTablesFor, widthAttrFor } from '../model/elements.ts';
import { nearestPointOnSegment } from '../utils/snap.ts';
import { resolveHostedGeometry, computeHostedPosition } from '../model/hosted.ts';
import { toElementId } from '../model/ids.ts';

const HOST_SNAP_THRESHOLD = 1;

function findNearestHost(
  cursor: Point,
  elements: ReadonlyMap<string, CanonicalElement>,
  hostTables: Set<string>,
): { wall: LineElement; t: number } | null {
  let best: { wall: LineElement; t: number; dist: number } | null = null;
  for (const el of elements.values()) {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if (!hostTables.has(el.tableName)) continue;
    const wall = el as LineElement;
    const projected = nearestPointOnSegment(cursor, wall.start, wall.end);
    const ddx = cursor.x - projected.x;
    const ddy = cursor.y - projected.y;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dist < HOST_SNAP_THRESHOLD && (!best || dist < best.dist)) {
      const dx = wall.end.x - wall.start.x;
      const dy = wall.end.y - wall.start.y;
      const lenSq = dx * dx + dy * dy;
      const wallLen = Math.sqrt(lenSq);
      const t = lenSq > 1e-10 ? Math.max(0, Math.min(wallLen, ((cursor.x - wall.start.x) * dx + (cursor.y - wall.start.y) * dy) / lenSq * wallLen)) : 0;
      best = { wall, t, dist };
    }
  }
  return best;
}

function findHostById(
  elementId: string,
  elements: ReadonlyMap<string, CanonicalElement>,
  hostTables: Set<string>,
): LineElement | null {
  const rawId = toElementId(elementId);
  const el = elements.get(rawId);
  if (!el) return null;
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  if (!hostTables.has(el.tableName)) return null;
  return el as LineElement;
}

function getLevelElevation(state: ToolStateSnapshot): number {
  if (!state.project) return 0;
  const level = state.project.levels.find(l => l.id === state.currentLevel);
  return level?.elevation ?? 0;
}

/**
 * Relocate-hosted tool: click on a wall to move the selected hosted element there.
 * Supports both 2D (floor-plane snap) and 3D (scene raycast).
 */
export const relocateHostedTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const state = ctx.getState();
    const { selectedIds, document: doc } = state;
    if (!doc || selectedIds.size !== 1) return;

    const sid = [...selectedIds][0];
    const el = doc.elements.get(toElementId(sid));
    if (!el || el.geometry !== 'line') return;

    const hostTables = hostTablesFor(el.tableName);
    const wAttr = widthAttrFor(el.tableName);
    const width = parseFloat(el.attrs[wAttr] || '0.9');
    const elementHeight = parseFloat(el.attrs.height || '2.1');
    const levelElevation = getLevelElevation(state);

    // Try 3D scene raycast
    const sceneHit = ctx.screenToScenePoint?.(e.clientX, e.clientY);
    let wall: LineElement | null = null;
    let t = 0;
    let baseOffset = 0;

    if (sceneHit) {
      wall = findHostById(sceneHit.elementId, doc.elements, hostTables);
      if (wall) {
        t = computeHostedPosition(wall, { x: sceneHit.x, y: sceneHit.y });
        if (el.tableName !== 'door') {
          const raw = sceneHit.elevation - levelElevation - elementHeight / 2;
          baseOffset = Math.max(0, Math.round(raw * 100) / 100);
        }
      }
    }

    // Fallback: 2D floor-plane
    if (!wall) {
      const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
      if (!svgPt) return;
      const hit = findNearestHost(svgPt, doc.elements, hostTables);
      if (!hit) return;
      wall = hit.wall;
      t = hit.t;
    }

    if (!wall) return;

    // Resolve new geometry
    const { start, end } = resolveHostedGeometry(wall, t, width);
    const position = t.toFixed(3);

    // Build updated element with new attrs and geometry
    const rawId = toElementId(sid);
    const before = new Map([[rawId, el as CanonicalElement | null]]);
    const updated: CanonicalElement = {
      ...el,
      start,
      end,
      hostId: wall.id,
      locationParam: t,
      attrs: { ...el.attrs, host_id: wall.id, position, base_offset: String(baseOffset) },
    } as LineElement;
    const after = new Map([[rawId, updated as CanonicalElement | null]]);
    ctx.dispatch({ type: 'COMMIT_PREVIEW', description: 'Move hosted element', before, after });

    // Return to select tool
    ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
    ctx.dispatch({ type: 'SET_DRAWING_TARGET', target: null });
    ctx.setSnap(null);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const state = ctx.getState();
    const { selectedIds, document: doc } = state;
    if (!doc || selectedIds.size !== 1) return;

    const sid = [...selectedIds][0];
    const el = doc.elements.get(toElementId(sid));
    if (!el || el.geometry !== 'line') return;

    const hostTables = hostTablesFor(el.tableName);
    const wAttr = widthAttrFor(el.tableName);
    const width = parseFloat(el.attrs[wAttr] || '0.9');
    const elementHeight = parseFloat(el.attrs.height || '2.1');
    const levelElevation = getLevelElevation(state);

    // Try 3D scene raycast
    const sceneHit = ctx.screenToScenePoint?.(e.clientX, e.clientY);
    if (sceneHit) {
      const wall = findHostById(sceneHit.elementId, doc.elements, hostTables);
      if (wall) {
        const t = computeHostedPosition(wall, { x: sceneHit.x, y: sceneHit.y });
        const { start, end } = resolveHostedGeometry(wall, t, width);
        let baseOffset = 0;
        if (el.tableName !== 'door') {
          const raw = sceneHit.elevation - levelElevation - elementHeight / 2;
          baseOffset = Math.max(0, Math.round(raw * 100) / 100);
        }
        ctx.dispatch({
          type: 'SET_DRAWING_STATE',
          state: { points: [start], cursor: end, baseOffset },
        });
        return;
      }
    }

    // Fallback: 2D
    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    if (!svgPt) return;

    const hit = findNearestHost(svgPt, doc.elements, hostTables);
    if (hit) {
      const { start, end } = resolveHostedGeometry(hit.wall, hit.t, width);
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
