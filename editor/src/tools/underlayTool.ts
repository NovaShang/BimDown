import type { ToolHandler, ToolContext } from './types.ts';
import type { Point } from '../model/elements.ts';
import { snapPoint, type SnapResult, type SnapType } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { getActiveUnderlayStore } from '../underlay/UnderlayContext.tsx';
import type { UnderlayMode } from '../underlay/store.ts';
import { typedKey, resolveTypedPoint } from './typedInput.ts';

/** Previous pick of the running interaction: anchors angle / length snaps. */
function anchorOf(mode: UnderlayMode): Point | undefined {
  if (mode.kind === 'calibrate') return undefined;
  if (mode.kind === 'move') return mode.base ?? undefined;
  return mode.center ?? undefined;
}

/** Calibration measures the drawing as drawn: only object snaps (model, DXF). */
const CALIBRATE_OFF: SnapType[] = ['grid', 'gridline', 'length', 'angle'];

/** The move's base point is a point of the underlay: only its own DXF
 *  geometry snaps (a raster has none, so it is picked exactly). */
const ALL_BUT_UNDERLAY: SnapType[] = ['endpoint', 'center', 'gridline', 'edge', 'midpoint', 'angle', 'length', 'grid', 'connector'];

/** Pointer position last seen, in plan coordinates (typed moves follow it). */
let lastCursor: Point | null = null;

function snapped(ctx: ToolContext, e: React.PointerEvent): SnapResult | null {
  const store = getActiveUnderlayStore();
  const mode = store?.getSnapshot().mode;
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (!store || !mode || !raw) return null;
  const s = ctx.getState();
  // Rotation snaps to 15° steps; Alt/Option picks freely.
  if (e.altKey) return { point: raw, snapX: null, snapY: null, guides: [] };
  let disabled = s.disabledSnapTypes;
  if (mode.kind === 'calibrate') disabled = new Set([...disabled, ...CALIBRATE_OFF]);
  if (store.pickingMoveBase) {
    if (store.assetKind(mode.id) !== 'dxf') return { point: raw, snapX: null, snapY: null, guides: [] };
    disabled = new Set([...disabled, ...ALL_BUT_UNDERLAY]);
  }
  return snapPoint(
    raw, ctx.screenToSvg, s.document?.elements, undefined, anchorOf(mode),
    mode.kind === 'rotate' ? 15 : 45, s.grids, undefined, undefined, getProjectUnits(s), disabled,
  );
}

/**
 * Picks points for the underlay interactions (calibrate / move / rotate) run
 * by the underlay store; snaps to the model, grids and DXF underlays. After
 * the move's base point, a typed distance (Tab: angle) moves it exactly.
 */
export const underlayTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const snap = snapped(ctx, e);
    if (!snap) return;
    getActiveUnderlayStore()?.click(snap.point);
    ctx.setSnap(null);
  },

  onPointerMove(ctx, e) {
    const snap = snapped(ctx, e);
    if (!snap) return;
    lastCursor = snap.point;
    getActiveUnderlayStore()?.pointerMove(snap.point);
    ctx.setSnap(snap);
  },

  onKeyDown(ctx, e) {
    const store = getActiveUnderlayStore();
    const snap = store?.getSnapshot();
    const mode = snap?.mode;
    if (!store || mode?.kind !== 'move' || !mode.base) return false;
    const r = typedKey(e, snap!.typed);
    if (!r.handled) return false;
    e.preventDefault();
    const target = r.commit && r.typed
      ? resolveTypedPoint(mode.base, snap!.cursor ?? lastCursor, r.typed, getProjectUnits(ctx.getState()))
      : null;
    if (target) store.click(target);
    else store.setTyped(r.typed);
    return true;
  },
};
