/**
 * Pick placement (placementType 'pick'): a floor, roof or ceiling whose
 * boundary comes from the walls under the cursor (geometry/pickBoundary.ts).
 *   - slab / structure_slab · by_walls: click a wall (whole outline) or inside
 *     a room; boundary at the `__face` chosen in the drawing bar.
 *   - roof · by_walls: same, at the exterior face + `__overhang`; edges get
 *     slopes from the roof type, the base sits so the underside meets the
 *     wall tops at their outer face, and `__attach` attaches the walls' tops.
 *   - ceiling · by_room: click inside a room; boundary at the wall faces.
 *   - roof · dormer: click a sloped roof plane (tools/dormerTool.ts).
 * One undo step per pick. The hovered boundary previews in the overlay.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, LineElement, PolygonElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { pickLoop, boundaryAt, loopWallIds, type BoundaryFace, type PickedLoop } from '../geometry/pickBoundary.ts';
import { legacyEdgeSlopes, formatNumberList } from '../geometry/roofSolver.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { dormerClick, dormerHover, isDormerTarget } from './dormerTool.ts';

export const FACE_KEY = '__face';
export const OVERHANG_KEY = '__overhang';
export const ATTACH_KEY = '__attach';

const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);
const ROOM_TABLES = new Set([...WALL_TABLES, 'room_separator']);

interface Pick {
  loop: PickedLoop;
  boundary: Point[];
}

function walls(state: ToolStateSnapshot, tables: Set<string>): LineElement[] {
  const out: LineElement[] = [];
  for (const el of state.document?.elements.values() ?? []) {
    if (tables.has(el.tableName) && el.geometry === 'line') out.push(el as LineElement);
  }
  return out;
}

/** The boundary the pick tool would create at `p` (null: nothing to pick there). */
export function pickAt(state: ToolStateSnapshot, p: Point): Pick | null {
  const target = state.drawingTarget;
  if (!target) return null;
  const isCeiling = target.tableName === 'ceiling';
  const loop = pickLoop(p, walls(state, isCeiling ? ROOM_TABLES : WALL_TABLES), { allowOuter: !isCeiling });
  if (!loop) return null;
  const types = state.project?.types;
  const attrs = state.drawingAttrs;
  let boundary: Point[] | null;
  if (target.tableName === 'roof') {
    const overhang = Math.max(0, parseFloat(attrs[OVERHANG_KEY] ?? '0.5') || 0);
    boundary = boundaryAt(loop, 'exterior', types, overhang);
  } else if (isCeiling) {
    boundary = boundaryAt(loop, 'interior', types);
  } else {
    boundary = boundaryAt(loop, (attrs[FACE_KEY] || 'core') as BoundaryFace, types);
  }
  return boundary && boundary.length >= 3 ? { loop, boundary } : null;
}

function cleanAttrs(attrs: Record<string, string>): Record<string, string> {
  const out = { ...attrs };
  for (const k of Object.keys(out)) if (k.startsWith('__')) delete out[k];
  return out;
}

/** Highest wall top (relative to the level) among the loop's walls. */
function wallTop(state: ToolStateSnapshot, loop: PickedLoop): number | null {
  const levels = state.project?.levels ?? [];
  const elevations = new Map(levels.map(l => [l.id, l.elevation]));
  const elev = elevations.get(state.currentLevel) ?? 0;
  let top = -Infinity;
  for (const e of loop.edges) {
    if (!e.wall) continue;
    const { height, baseOffset } = resolveHeight(e.wall.attrs, elev, elevations, 3);
    top = Math.max(top, baseOffset + height);
  }
  return Number.isFinite(top) ? top : null;
}

/** Elements (and wall updates) one pick creates. */
export function buildPick(state: ToolStateSnapshot, pick: Pick): Map<string, CanonicalElement> | null {
  const target = state.drawingTarget;
  if (!target || !state.document) return null;
  const ids = new Set(state.document.elements.keys());
  const id = generateId(target.tableName, ids);
  const attrs: Record<string, string> = cleanAttrs({
    ...defaultAttrs(target.tableName, resolveNextLevelId(state)),
    ...variantDefaults(target.tableName, target.variantId),
    ...state.drawingAttrs,
    id,
  });
  // Associated with the picked walls: the outline follows them (geometry/pickBoundary.ts rebuildBoundary)
  const wallIds = loopWallIds(pick.loop);
  if (wallIds.length >= 2) {
    attrs.boundary_walls = wallIds.join(';');
    attrs.boundary_face = target.tableName === 'roof' ? 'exterior' : target.tableName === 'ceiling' ? 'interior' : (state.drawingAttrs[FACE_KEY] || 'core');
    if (target.tableName === 'roof') attrs.boundary_offset = String(Math.max(0, parseFloat(state.drawingAttrs[OVERHANG_KEY] ?? '0.5') || 0));
  }
  const out = new Map<string, CanonicalElement>();
  if (target.tableName === 'roof') {
    const roofType = attrs.roof_type || 'hip';
    const slope = parseFloat(attrs.slope || '0') || 0;
    const slopes = roofType === 'flat' || slope <= 0
      ? pick.boundary.map(() => 0)
      : legacyEdgeSlopes(pick.boundary, roofType === 'mansard' || roofType === 'extrusion' ? 'hip' : roofType, slope);
    if (slopes.some(v => v > 0)) attrs.edge_slopes = formatNumberList(slopes);
    else delete attrs.edge_slopes;
    // Underside meets the wall tops at their outer face: drop by overhang × slope.
    const top = wallTop(state, pick.loop);
    const overhang = Math.max(0, parseFloat(state.drawingAttrs[OVERHANG_KEY] ?? '0.5') || 0);
    if (top !== null) {
      const drop = slope > 0 && roofType !== 'flat' ? overhang * Math.tan((slope * Math.PI) / 180) : 0;
      attrs.base_offset = String(Math.round((top - drop) * 1000) / 1000);
    }
    if ((state.drawingAttrs[ATTACH_KEY] ?? 'yes') === 'yes') {
      for (const e of pick.loop.edges) {
        if (!e.wall || (e.wall.tableName !== 'wall' && e.wall.tableName !== 'structure_wall')) continue;
        const w = state.document.elements.get(e.wall.id);
        if (w) out.set(w.id, { ...w, attrs: { ...w.attrs, top_attach_id: id } });
      }
    }
  }
  const el: PolygonElement = {
    id,
    tableName: target.tableName,
    discipline: target.discipline,
    geometry: 'polygon',
    vertices: pick.boundary.map(p => ({ x: round(p.x), y: round(p.y) })),
    attrs,
  };
  out.set(id, el);
  return out;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function cursorPoint(ctx: ToolContext, e: React.PointerEvent): Point | null {
  return ctx.screenToSvg(e.clientX, e.clientY);
}

export const drawPickTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    const p = cursorPoint(ctx, e);
    if (!p) return;
    if (isDormerTarget(ctx.getState())) { dormerHover(ctx, p); return; }
    const pick = pickAt(ctx.getState(), p);
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: pick ? pick.boundary : [], cursor: p } });
  },

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = cursorPoint(ctx, e);
    if (!p) return;
    const state = ctx.getState();
    if (isDormerTarget(state)) { dormerClick(ctx, p); return; }
    const pick = pickAt(state, p);
    if (!pick) return;
    const patches = buildPick(state, pick);
    if (!patches) return;
    ctx.dispatch({
      type: 'APPLY_PATCH',
      description: `${state.drawingTarget?.tableName ?? 'element'} by walls`,
      patches: patches as Map<string, CanonicalElement | null>,
    });
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p } });
  },
};
