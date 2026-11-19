/**
 * Placement of library components: a live ghost of the plan symbol follows
 * the cursor; components whose family is `wallBacked` turn their back to the
 * nearest wall face and slide along it (flush into corners and against
 * neighbours). Alt held = free placement. R / Shift+R rotate by 90°, M mirrors
 * (keys: LibraryPanel usePlacementKeys).
 */
import type { ToolHandler, ToolContext } from '../tools/types.ts';
import type { PointElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from '../tools/levelUtil.ts';
import { resolveFurniture } from './furnitureLibrary.generated.ts';
import { snapBackToWall } from './wallSnap.ts';
import { metre } from '../annotation/geometry.ts';

interface Pose { position: Point; rotationDeg: number; wallSnapped: boolean }

function poseAt(ctx: ToolContext, e: React.PointerEvent): { pose: Pose; snap: ReturnType<typeof snapPoint> | null } | null {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const attrs = state.drawingAttrs;
  const r = resolveFurniture(attrs, metre());
  const userRot = parseFloat(attrs.rotation || '0') || 0;
  if (r.family.wallBacked && !e.altKey && state.document) {
    const wall = snapBackToWall(svgPt, r.size.w, r.size.d, state.document.elements);
    if (wall) return { pose: { position: wall.position, rotationDeg: wall.rotationDeg, wallSnapped: true }, snap: null };
  }
  const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined,
    state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
  return { pose: { position: snap.point, rotationDeg: userRot, wallSnapped: false }, snap };
}

export const placeFurnitureTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerMove(ctx, e) {
    const hit = poseAt(ctx, e);
    if (!hit) return;
    ctx.dispatch({
      type: 'SET_DRAWING_STATE',
      state: { points: [], cursor: hit.pose.position, rotation: hit.pose.rotationDeg },
    });
    ctx.setSnap(hit.snap);
  },

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const state = ctx.getState();
    const target = state.drawingTarget;
    if (!target) return;
    const hit = poseAt(ctx, e);
    if (!hit) return;
    const { pose } = hit;

    const base = defaultAttrs(target.tableName, resolveNextLevelId(state));
    const merged: Record<string, string> = { ...base, ...state.drawingAttrs };
    for (const k of Object.keys(merged)) if (k.startsWith('__')) delete merged[k];
    const r = resolveFurniture(merged, metre());
    const id = generateId(target.tableName, new Set(state.document?.elements.keys() ?? []));
    const attrs: Record<string, string> = {
      ...merged,
      family: r.family.id,
      variant: r.params.variant,
      size_x: String(r.size.w),
      size_y: String(r.size.d),
      height: String(r.size.h),
      rotation: String(Math.round(pose.rotationDeg * 1000) / 1000),
    };
    const element: PointElement = {
      id,
      tableName: target.tableName,
      discipline: target.discipline,
      geometry: 'point',
      position: { x: Math.round(pose.position.x * 1000) / 1000, y: Math.round(pose.position.y * 1000) / 1000 },
      width: r.size.w,
      height: r.size.d,
      attrs,
    };
    ctx.dispatch({ type: 'CREATE_ELEMENT', element });
    ctx.setSnap(null);
  },
};
