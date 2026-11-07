import type { ToolHandler, ToolContext } from './types.ts';
import type { Point } from '../model/elements.ts';
import { snapPoint, type SnapResult, type SnapType } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { getActiveUnderlayStore } from '../underlay/UnderlayContext.tsx';
import type { UnderlayMode } from '../underlay/store.ts';

/** Previous pick of the running interaction: anchors angle / length snaps. */
function anchorOf(mode: UnderlayMode): Point | undefined {
  if (mode.kind === 'calibrate') return undefined;
  if (mode.kind === 'move') return mode.base ?? undefined;
  return mode.center ?? undefined;
}

/** Calibration measures the drawing as drawn: only object snaps (model, DXF). */
const CALIBRATE_OFF: SnapType[] = ['grid', 'gridline', 'length', 'angle'];

function snapped(ctx: ToolContext, e: React.PointerEvent): SnapResult | null {
  const store = getActiveUnderlayStore();
  const mode = store?.getSnapshot().mode;
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (!store || !mode || !raw) return null;
  const s = ctx.getState();
  // Rotation snaps to 15° steps; Alt/Option picks freely.
  if (e.altKey) return { point: raw, snapX: null, snapY: null, guides: [] };
  return snapPoint(
    raw, ctx.screenToSvg, s.document?.elements, undefined, anchorOf(mode),
    mode.kind === 'rotate' ? 15 : 45, s.grids, undefined, undefined, getProjectUnits(s),
    mode.kind === 'calibrate' ? new Set([...s.disabledSnapTypes, ...CALIBRATE_OFF]) : s.disabledSnapTypes,
  );
}

/**
 * Picks points for the underlay interactions (calibrate / move / rotate) run
 * by the underlay store; snaps to the model, grids and DXF underlays.
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
    getActiveUnderlayStore()?.pointerMove(snap.point);
    ctx.setSnap(snap);
  },
};
