/**
 * Revit-style wall placement for wall-like line tables (wall, structure_wall,
 * curtain_wall, room_separator):
 *
 *   line  — chain: every click continues from the last point; clicking the
 *           chain start closes it; Esc / Enter / a second click on the same
 *           point (double-click) ends it.
 *   rect  — two opposite corners → four joined walls (drawn clockwise).
 *   arc   — start, end, then a point the arc passes through; chains too.
 *   pick  — click a grid line, room separator or wall to place a wall on it
 *           (with an offset toward the cursor: Revit's Pick Lines / Offset).
 *
 * Location line (centre / exterior face / interior face) and a numeric offset
 * shift the wall centreline off the clicked path; consecutive chain walls are
 * re-met at the intersection of their shifted lines so corners stay joined.
 * Exterior is the left side of the drawing direction (outside when drawing
 * clockwise). Typed length / angle: see typedInput.ts.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import type { ArcParams } from '../geometry/arc.ts';
import type { DrawingState } from '../state/editorTypes.ts';
import { arcFromMidpoint, pointOnArc } from '../geometry/arc.ts';
import { intersectLines, isJoinable, projectOnWall, wallFrame } from '../geometry/wallJoins.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { computePixelSize, nearestPointOnSegment, snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { variantDefaults } from './variantDefaults.ts';
import { typedKey, resolveTypedPoint, resolveTypedRectCorner } from './typedInput.ts';

export const WALL_DRAW_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);

export function isWallDrawTable(table: string | null | undefined): boolean {
  return !!table && WALL_DRAW_TABLES.has(table);
}

// ─── Options (reserved drawingAttrs keys, never persisted) ──────────────────

export type WallDrawMode = 'line' | 'rect' | 'arc' | 'pick';
export type LocationLine = 'center' | 'exterior' | 'interior';

export const WALL_OPT = {
  mode: '__wall_mode',
  chain: '__chain',
  loc: '__loc_line',
  offset: '__offset',
} as const;

export interface WallDrawOptions {
  mode: WallDrawMode;
  chain: boolean;
  loc: LocationLine;
  offset: number;
}

/** Last chosen options, so re-entering the tool keeps them (like Revit). */
const remembered: Record<string, string> = {};

export function wallDrawOptions(attrs: Record<string, string>): WallDrawOptions {
  const get = (k: string) => attrs[k] ?? remembered[k];
  const mode = get(WALL_OPT.mode);
  const loc = get(WALL_OPT.loc);
  const offset = parseFloat(get(WALL_OPT.offset) ?? '');
  return {
    mode: mode === 'rect' || mode === 'arc' || mode === 'pick' ? mode : 'line',
    chain: get(WALL_OPT.chain) !== 'false',
    loc: loc === 'exterior' || loc === 'interior' ? loc : 'center',
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

export function withWallDrawOption(attrs: Record<string, string>, key: string, value: string): Record<string, string> {
  remembered[key] = value;
  return { ...attrs, [key]: value };
}

/** Drop UI-only `__` keys before attrs reach a CSV row. */
export function persistedAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (!k.startsWith('__')) out[k] = v;
  return out;
}

const FALLBACK_STROKE: Record<string, number> = { wall: 0.2, structure_wall: 0.2, curtain_wall: 0.05, room_separator: 0.1 };

function thicknessOf(state: ToolStateSnapshot): number {
  const table = state.drawingTarget?.tableName ?? 'wall';
  return resolveLineStrokeWidth(table, state.drawingAttrs) ?? FALLBACK_STROKE[table] ?? 0.1;
}

/** Signed shift of the centreline from the clicked path (+ = left of travel). */
export function centreShift(opts: WallDrawOptions, thickness: number): number {
  const loc = opts.loc === 'exterior' ? -thickness / 2 : opts.loc === 'interior' ? thickness / 2 : 0;
  return loc + opts.offset;
}

// ─── Geometry ───────────────────────────────────────────────────────────────

export interface WallSpan { start: Point; end: Point; arc?: ArcParams }

function shiftSeg(a: Point, b: Point, s: number): WallSpan {
  const f = wallFrame({ start: a, end: b });
  if (!f || s === 0) return { start: { ...a }, end: { ...b } };
  return {
    start: { x: a.x + f.n.x * s, y: a.y + f.n.y * s },
    end: { x: b.x + f.n.x * s, y: b.y + f.n.y * s },
  };
}

function shiftArc(a: Point, b: Point, through: Point, s: number): WallSpan {
  const arc = arcFromMidpoint(a, b, through);
  if (!arc) return shiftSeg(a, b, s);
  if (s === 0) return { start: { ...a }, end: { ...b }, arc };
  const at = (t: number) => {
    const { point, tangent } = pointOnArc(a, b, arc, t);
    return { x: point.x - tangent.y * s, y: point.y + tangent.x * s };
  };
  const start = at(0), end = at(1), mid = at(0.5);
  return { start, end, arc: arcFromMidpoint(start, end, mid) };
}

/** Meet two straight spans at the intersection of their lines (in place). */
function meet(prev: WallSpan, next: WallSpan): Point | null {
  if (prev.arc || next.arc) return null;
  const fp = wallFrame(prev), fn = wallFrame(next);
  if (!fp || !fn) return null;
  const x = intersectLines(prev.start, fp.u, next.start, fn.u);
  if (!x) return null;
  prev.end = { ...x };
  next.start = { ...x };
  return x;
}

/**
 * If `p` lands inside another wall's thickness (not at its ends), slide it
 * along the new wall's own line onto that wall's centreline so the tee is a
 * real join (2D miter, 3D, and the room boundary graph all key on it).
 */
export function seatOnWalls(
  elements: ReadonlyMap<string, CanonicalElement> | undefined,
  from: Point,
  p: Point,
  exclude: ReadonlySet<string>,
): Point {
  if (!elements) return p;
  const d = { x: p.x - from.x, y: p.y - from.y };
  if (Math.hypot(d.x, d.y) < 1e-9) return p;
  for (const el of elements.values()) {
    if (!isJoinable(el) || el.arc || exclude.has(el.id)) continue;
    const f = wallFrame(el);
    const pr = projectOnWall(el, p);
    if (!f || !pr) continue;
    const hw = el.strokeWidth / 2 + 0.005;
    if (Math.abs(pr.offset) > hw || pr.along < -hw || pr.along > f.len + hw) continue;
    // Near an end: snap to it (corner join) rather than the body.
    for (const e of [el.start, el.end]) {
      if (Math.hypot(e.x - p.x, e.y - p.y) <= hw) return { ...e };
    }
    if (pr.along <= 0 || pr.along >= f.len) continue;
    const x = intersectLines(from, d, el.start, f.u);
    if (x && Math.hypot(x.x - p.x, x.y - p.y) <= 2 * hw) return x;
  }
  return p;
}

function rectSpans(a: Point, b: Point, s: number): WallSpan[] {
  const x0 = Math.min(a.x, b.x) - s, x1 = Math.max(a.x, b.x) + s;
  const y0 = Math.min(a.y, b.y) - s, y1 = Math.max(a.y, b.y) + s;
  const tl = { x: x0, y: y1 }, tr = { x: x1, y: y1 }, br = { x: x1, y: y0 }, bl = { x: x0, y: y0 };
  return [
    { start: tl, end: tr }, { start: { ...tr }, end: br },
    { start: { ...br }, end: bl }, { start: { ...bl }, end: { ...tl } },
  ];
}

interface PickLine { start: Point; end: Point; wallId?: string }

function findPickLine(ctx: ToolContext, state: ToolStateSnapshot, p: Point): PickLine | null {
  const tol = computePixelSize(ctx.screenToSvg) * 10;
  let best: PickLine | null = null, bestD = tol;
  const consider = (a: Point, b: Point, wallId?: string) => {
    const q = nearestPointOnSegment(p, a, b);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) { bestD = d; best = { start: a, end: b, wallId }; }
  };
  for (const g of state.grids) consider({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
  for (const el of state.document?.elements.values() ?? []) {
    if (!isJoinable(el) || el.arc) continue;
    if (el.tableName === 'room_separator') consider(el.start, el.end);
    else {
      // Walls are picked anywhere on their body.
      const q = nearestPointOnSegment(p, el.start, el.end);
      const d = Math.max(0, Math.hypot(q.x - p.x, q.y - p.y) - el.strokeWidth / 2);
      if (d <= bestD) { bestD = d; best = { start: el.start, end: el.end, wallId: el.id }; }
    }
  }
  return best;
}

function pickSpan(state: ToolStateSnapshot, line: PickLine, cursor: Point, opts: WallDrawOptions): WallSpan | null {
  const pr = projectOnWall(line, cursor);
  if (!pr) return null;
  const side = pr.offset < 0 ? -1 : 1;
  // A picked wall gets a parallel copy `offset` away (centre to centre); a
  // picked line gets the wall on it, its chosen face on the line.
  const mag = line.wallId
    ? Math.abs(opts.offset)
    : (opts.loc === 'center' ? 0 : thicknessOf(state) / 2) + opts.offset;
  if (line.wallId && mag < 1e-6) return null;
  return shiftSeg(line.start, line.end, side * mag);
}

// ─── Planning a click ───────────────────────────────────────────────────────

interface Plan {
  spans: WallSpan[];
  /** Existing chain walls whose ends move to meet the new one. */
  adjust: Map<string, Partial<WallSpan>>;
  closes: boolean;
}

/** The walls a click at `pt` creates in line / arc mode. */
function planChain(state: ToolStateSnapshot, anchor: Point, pt: Point, through: Point | null, forPreview: boolean): Plan {
  const opts = wallDrawOptions(state.drawingAttrs);
  const s = centreShift(opts, thicknessOf(state));
  const ds = state.drawingState;
  const chain = ds?.chain ?? { path: [anchor], ids: [], through: [] };
  const span = through ? shiftArc(anchor, pt, through, s) : shiftSeg(anchor, pt, s);
  const adjust = new Map<string, Partial<WallSpan>>();
  const els = state.document?.elements;
  const lineOf = (id: string): WallSpan | null => {
    const el = els?.get(id);
    return el && (el.geometry === 'line' || el.geometry === 'spatial_line') ? { start: el.start, end: el.end, arc: el.arc } : null;
  };
  const chainIds = new Set(chain.ids);

  const lastId = chain.ids[chain.ids.length - 1];
  if (lastId) {
    const prev = lineOf(lastId);
    if (prev && s !== 0) {
      const copy = { ...prev };
      if (meet(copy, span)) adjust.set(lastId, { end: copy.end });
    }
  } else if (!through) {
    span.start = seatOnWalls(els, span.end, span.start, chainIds);
  }

  const closes = opts.mode !== 'rect' && chain.path.length >= 3
    && Math.hypot(pt.x - chain.path[0].x, pt.y - chain.path[0].y) < 1e-6;
  if (closes) {
    const firstId = chain.ids[0];
    const first = firstId ? lineOf(firstId) : null;
    if (first && firstId) {
      if (s !== 0) {
        const copy = { ...first };
        if (meet(span, copy)) adjust.set(firstId, { ...(adjust.get(firstId) ?? {}), start: copy.start });
      } else {
        span.end = { ...first.start };
      }
    }
  } else if (!through && !forPreview) {
    span.end = seatOnWalls(els, span.start, span.end, chainIds);
  }
  return { spans: [span], adjust, closes };
}

function buildWall(state: ToolStateSnapshot, span: WallSpan, id: string): LineElement {
  const target = state.drawingTarget!;
  const da = persistedAttrs(state.drawingAttrs);
  const attrs: Record<string, string> = {
    ...defaultAttrs(target.tableName, resolveNextLevelId(state)),
    ...variantDefaults(target.tableName, target.variantId),
    ...da,
    id,
  };
  const el: LineElement = {
    id, tableName: target.tableName, discipline: target.discipline, geometry: 'line',
    start: { ...span.start }, end: { ...span.end }, strokeWidth: thicknessOf(state), attrs,
  };
  if (span.arc) el.arc = span.arc;
  return el;
}

/** Create the planned walls in one undo step; returns the new ids. */
function commitPlan(ctx: ToolContext, plan: Plan): string[] {
  const state = ctx.getState();
  const els = state.document?.elements;
  if (!els || !state.drawingTarget) return [];
  const existing = new Set(els.keys());
  const patches = new Map<string, CanonicalElement | null>();
  const ids: string[] = [];
  for (const span of plan.spans) {
    if (Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) < 1e-4) continue;
    const id = generateId(state.drawingTarget.tableName, existing);
    existing.add(id);
    patches.set(id, buildWall(state, span, id));
    ids.push(id);
  }
  for (const [id, ch] of plan.adjust) {
    const el = els.get(id);
    if (el && (el.geometry === 'line' || el.geometry === 'spatial_line')) patches.set(id, { ...el, ...ch });
  }
  if (ids.length === 0) return [];
  ctx.dispatch({ type: 'APPLY_PATCH', description: ids.length > 1 ? 'Draw walls' : 'Draw wall', patches });
  return ids;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

function snapAt(ctx: ToolContext, e: { clientX: number; clientY: number }) {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const ds = state.drawingState;
  const anchor = ds?.arcEnd ? undefined : ds?.points[0];
  const extra = ds?.chain?.path.length ? [ds.chain.path[0]] : undefined;
  return snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, extra, undefined, getProjectUnits(state), state.disabledSnapTypes);
}

function endChain(ctx: ToolContext, cursor: Point | null) {
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor } });
}

/** Handle a placed point (click or typed). */
function place(ctx: ToolContext, pt: Point) {
  const state = ctx.getState();
  const opts = wallDrawOptions(state.drawingAttrs);
  const ds: DrawingState = state.drawingState ?? { points: [], cursor: null };
  const anchor = ds.points[0];

  if (opts.mode === 'pick') {
    const line = findPickLine(ctx, state, pt);
    const span = line && pickSpan(state, line, pt, opts);
    if (span) commitPlan(ctx, { spans: [span], adjust: new Map(), closes: false });
    return;
  }

  if (!anchor) {
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [pt], cursor: pt, chain: { path: [pt], ids: [], through: [] } } });
    return;
  }
  // Second click on the same point (a double-click) ends the chain.
  if (Math.hypot(pt.x - anchor.x, pt.y - anchor.y) < 1e-6 && !ds.arcEnd) {
    endChain(ctx, pt);
    return;
  }

  if (opts.mode === 'rect') {
    if (Math.abs(pt.x - anchor.x) < 1e-6 || Math.abs(pt.y - anchor.y) < 1e-6) return;
    const s = centreShift(opts, thicknessOf(state));
    commitPlan(ctx, { spans: rectSpans(anchor, pt, s), adjust: new Map(), closes: true });
    endChain(ctx, pt);
    return;
  }

  if (opts.mode === 'arc' && !ds.arcEnd) {
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, arcEnd: pt, typed: undefined, ghost: undefined } });
    return;
  }

  const end = ds.arcEnd ?? pt;
  const through = ds.arcEnd ? pt : null;
  const plan = planChain(state, anchor, end, through, false);
  const ids = commitPlan(ctx, plan);
  if (ids.length === 0) return;
  if (plan.closes || !opts.chain) {
    endChain(ctx, end);
    return;
  }
  const chain = ds.chain ?? { path: [anchor], ids: [], through: [] };
  ctx.dispatch({
    type: 'SET_DRAWING_STATE',
    state: {
      points: [end], cursor: end,
      chain: { path: [...chain.path, end], ids: [...chain.ids, ...ids], through: [...chain.through, through] },
    },
  });
}

function ghostFor(ctx: ToolContext, state: ToolStateSnapshot, cursor: Point): DrawingState['ghost'] {
  const opts = wallDrawOptions(state.drawingAttrs);
  const ds = state.drawingState;
  const anchor = ds?.points[0];
  if (opts.mode === 'pick') {
    const line = findPickLine(ctx, state, cursor);
    const span = line && pickSpan(state, line, cursor, opts);
    return span ? [span] : undefined;
  }
  if (!anchor) return undefined;
  const s = centreShift(opts, thicknessOf(state));
  if (opts.mode === 'rect') return rectSpans(anchor, cursor, s);
  if (ds?.arcEnd) return planChain(state, anchor, ds.arcEnd, cursor, true).spans;
  return planChain(state, anchor, cursor, null, true).spans;
}

export const wallDrawTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    // Pick mode works on the raw cursor: its side of the line picks the side.
    if (wallDrawOptions(ctx.getState().drawingAttrs).mode === 'pick') {
      const raw = ctx.screenToSvg(e.clientX, e.clientY);
      if (raw) place(ctx, raw);
      return;
    }
    const snap = snapAt(ctx, e);
    if (!snap) return;
    ctx.setSnap(snap);
    place(ctx, snap.point);
  },

  onPointerMove(ctx, e) {
    const state = ctx.getState();
    const ds = state.drawingState ?? { points: [], cursor: null };
    if (wallDrawOptions(state.drawingAttrs).mode === 'pick') {
      const raw = ctx.screenToSvg(e.clientX, e.clientY);
      if (raw) ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, cursor: raw, ghost: ghostFor(ctx, state, raw) } });
      ctx.setSnap(null);
      return;
    }
    const snap = snapAt(ctx, e);
    if (!snap) return;
    if (ds.points.length > 0) {
      // While a length is typed, the preview keeps it and only follows the direction.
      let target = snap.point;
      if (ds.typed && !ds.arcEnd) {
        const unit = getProjectUnits(state);
        target = (wallDrawOptions(state.drawingAttrs).mode === 'rect'
          ? resolveTypedRectCorner(ds.points[0], snap.point, ds.typed, unit)
          : resolveTypedPoint(ds.points[0], snap.point, ds.typed, unit)) ?? snap.point;
      }
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, cursor: snap.point, ghost: ghostFor(ctx, state, target) } });
    }
    ctx.setSnap(snap);
  },

  onKeyDown(ctx, e) {
    const state = ctx.getState();
    const ds = state.drawingState;
    const anchor = ds?.points[0];
    if (!ds || !anchor) return false;
    const opts = wallDrawOptions(state.drawingAttrs);
    if (!ds.arcEnd && opts.mode !== 'pick') {
      const r = typedKey(e, ds.typed);
      if (r.handled) {
        e.preventDefault();
        const unit = getProjectUnits(state);
        const pt = !r.typed ? null : opts.mode === 'rect'
          ? resolveTypedRectCorner(anchor, ds.cursor, r.typed, unit)
          : resolveTypedPoint(anchor, ds.cursor, r.typed, unit);
        if (r.commit) {
          // place() writes a fresh drawing state, which drops the typed value.
          if (pt) place(ctx, pt);
        } else {
          // Preview the walls at the typed size, not at the cursor.
          const next = { ...ds, typed: r.typed };
          const ghost = ghostFor(ctx, { ...state, drawingState: next }, pt ?? ds.cursor ?? anchor);
          ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...next, ghost } });
        }
        return true;
      }
    }
    if (e.key === 'Enter' || (e.key === 'Escape' && ds.arcEnd)) {
      endChain(ctx, ds.cursor);
      return true;
    }
    return false;
  },
};
