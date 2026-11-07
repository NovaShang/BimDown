/**
 * Region placement (placementType 'region'): drag a box, or click a grid bay,
 * and the active variant lays out many structural members at once:
 *   - structure_column · at_grids        → a column at every grid crossing in the box
 *   - beam             · between_columns → beams between neighbouring columns in the box
 *   - beam             · beam_system     → parallel infill beams across the bay
 * One CREATE_ELEMENTS dispatch, so a single undo step.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, LineElement, Point, PointElement, SpatialLineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import {
  beamSystemLines, beamsBetweenColumns, gridBayAt, gridDirections, gridIntersections, inRect, rectBay,
  type Segment,
} from '../model/structuralLayout.ts';
import { COLUMN_TABLES } from '../elements/_framing.ts';

import { BEAM_SPACING_KEY, BEAM_SPAN_KEY } from '../model/structuralLayout.ts';
export { BEAM_SPACING_KEY, BEAM_SPAN_KEY };

/** Screen-pixel drag below which pointer-up counts as a click. */
const CLICK_PX = 4;

type Variant = 'at_grids' | 'between_columns' | 'beam_system';

function variantOf(state: ToolStateSnapshot): Variant | null {
  const v = state.drawingTarget?.variantId;
  return v === 'at_grids' || v === 'between_columns' || v === 'beam_system' ? v : null;
}

function snapped(ctx: ToolContext, e: React.PointerEvent): Point | null {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const snap = snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, undefined, undefined,
    state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
  ctx.setSnap(snap);
  return snap.point;
}

/** Element attrs for a new member: table defaults < variant defaults < bar values, minus UI keys. */
function memberAttrs(state: ToolStateSnapshot, table: string, variantId?: string): Record<string, string> {
  const attrs: Record<string, string> = {
    ...defaultAttrs(table, resolveNextLevelId(state)),
    ...variantDefaults(table, variantId),
    ...state.drawingAttrs,
  };
  for (const k of Object.keys(attrs)) if (k.startsWith('__')) delete attrs[k];
  return attrs;
}

/** Columns at the grid crossings inside the box (skipping occupied crossings). */
export function columnsAtGrids(state: ToolStateSnapshot, a: Point, b: Point, click: boolean): CanonicalElement[] {
  const target = state.drawingTarget;
  if (!target) return [];
  let pts = gridIntersections(state.grids);
  if (click) {
    // A click takes the crossing nearest the cursor (within 1 m).
    const near = pts
      .map(p => ({ p, d: Math.hypot(p.x - a.x, p.y - a.y) }))
      .filter(x => x.d <= 1)
      .sort((x, y) => x.d - y.d);
    pts = near.length > 0 ? [near[0].p] : [];
  } else {
    pts = pts.filter(p => inRect(p, a, b));
  }
  const occupied = existingColumnPoints(state);
  pts = pts.filter(p => !occupied.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 0.05));
  if (pts.length === 0) return [];

  const ids = new Set(state.document?.elements.keys() ?? []);
  const base = memberAttrs(state, target.tableName, target.variantId);
  const w = parseFloat(base.size_x || '0.3') || 0.3;
  const h = parseFloat(base.size_y || '') || w;
  return pts.map(p => {
    const id = generateId(target.tableName, ids);
    ids.add(id);
    const el: PointElement = {
      id, tableName: target.tableName, discipline: target.discipline,
      geometry: 'point', position: p, width: w, height: h,
      attrs: { ...base, id, size_x: String(w), size_y: String(h) },
    };
    return el;
  });
}

function existingColumnPoints(state: ToolStateSnapshot): Point[] {
  const out: Point[] = [];
  for (const el of state.document?.elements.values() ?? []) {
    if ((COLUMN_TABLES as readonly string[]).includes(el.tableName) && el.geometry === 'point') out.push(el.position);
  }
  return out;
}

function existingBeamSegments(state: ToolStateSnapshot): Segment[] {
  const out: Segment[] = [];
  for (const el of state.document?.elements.values() ?? []) {
    if (el.tableName !== 'beam') continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    out.push([el.start, el.end]);
  }
  return out;
}

/** Beam elements (level-relative z from `attrs.start_z/end_z`) along segments. */
export function beamElements(segments: Segment[], attrs: Record<string, string>, existingIds: Iterable<string>): SpatialLineElement[] {
  const ids = new Set(existingIds);
  const startZ = parseFloat(attrs.start_z ?? '0') || 0;
  const endZ = parseFloat(attrs.end_z ?? `${startZ}`) || startZ;
  const strokeWidth = parseFloat(attrs.size_x || '0.3') || 0.3;
  return segments.map(([s, e]) => {
    const id = generateId('beam', ids);
    ids.add(id);
    return {
      id, tableName: 'beam', discipline: 'structure',
      geometry: 'spatial_line', start: s, end: e, startZ, endZ, strokeWidth,
      attrs: { ...attrs, id },
    };
  });
}

/** Beams (spatial lines, z from the drawing bar) along the given segments. */
export function beamsAlong(state: ToolStateSnapshot, segments: Segment[], variantId?: string): CanonicalElement[] {
  if (!state.drawingTarget || segments.length === 0) return [];
  return beamElements(segments, memberAttrs(state, 'beam', variantId), state.document?.elements.keys() ?? []);
}

/** Beams between the neighbouring columns inside the box (or the clicked bay). */
export function beamsBetweenColumnsIn(state: ToolStateSnapshot, a: Point, b: Point, click: boolean): CanonicalElement[] {
  let lo = a, hi = b;
  if (click) {
    const bay = gridBayAt(a, state.grids);
    if (!bay) return [];
    const xs = bay.map(p => p.x), ys = bay.map(p => p.y);
    lo = { x: Math.min(...xs), y: Math.min(...ys) };
    hi = { x: Math.max(...xs), y: Math.max(...ys) };
  }
  const cols = existingColumnPoints(state).filter(p => inRect(p, lo, hi, 0.05));
  const segs = beamsBetweenColumns(cols, gridDirections(state.grids), existingBeamSegments(state));
  return beamsAlong(state, segs, state.drawingTarget?.variantId);
}

/** Beam system across the clicked grid bay, or across the dragged box. */
export function beamSystemIn(state: ToolStateSnapshot, a: Point, b: Point, click: boolean): CanonicalElement[] {
  const bay = click ? gridBayAt(a, state.grids) : rectBay(a, b);
  if (!bay) return [];
  const spacing = parseFloat(state.drawingAttrs[BEAM_SPACING_KEY] ?? '2') || 2;
  const span = state.drawingAttrs[BEAM_SPAN_KEY] === 'long' ? 'long' : 'short';
  return beamsAlong(state, beamSystemLines(bay, spacing, span), state.drawingTarget?.variantId);
}

function layout(state: ToolStateSnapshot, a: Point, b: Point, click: boolean): CanonicalElement[] {
  switch (variantOf(state)) {
    case 'at_grids': return columnsAtGrids(state, a, b, click);
    case 'between_columns': return beamsBetweenColumnsIn(state, a, b, click);
    case 'beam_system': return beamSystemIn(state, a, b, click);
    default: return [];
  }
}

let downScreen: { x: number; y: number } | null = null;

export const drawRegionTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const pt = snapped(ctx, e);
    if (!pt) return;
    downScreen = { x: e.clientX, y: e.clientY };
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [pt], cursor: pt } });
  },

  onPointerMove(ctx, e) {
    const pt = snapped(ctx, e);
    if (!pt) return;
    const ds = ctx.getState().drawingState;
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: ds?.points ?? [], cursor: pt } });
  },

  onPointerUp(ctx, e) {
    const state = ctx.getState();
    const start = state.drawingState?.points[0];
    if (!start || !downScreen) return;
    const click = Math.hypot(e.clientX - downScreen.x, e.clientY - downScreen.y) < CLICK_PX;
    downScreen = null;
    const end = click ? start : (snapped(ctx, e) ?? start);
    const elements = layout(state, start, end, click);
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: end } });
    ctx.setSnap(null);
    if (elements.length === 0) return;
    ctx.dispatch({
      type: 'CREATE_ELEMENTS',
      elements,
      description: `Place ${elements.length} ${elements[0].tableName === 'beam' ? 'beams' : 'columns'}`,
      selectPrimary: false,
    });
  },
};

/** Line / point previews of what a region would create (DrawingOverlay). */
export function previewRegion(state: ToolStateSnapshot, a: Point, b: Point): { points: Point[]; lines: Segment[] } {
  const els = layout(state, a, b, false);
  const points: Point[] = [];
  const lines: Segment[] = [];
  for (const el of els) {
    if (el.geometry === 'point') points.push(el.position);
    else if (el.geometry === 'line' || el.geometry === 'spatial_line') lines.push([(el as LineElement).start, el.end]);
  }
  return { points, lines };
}
