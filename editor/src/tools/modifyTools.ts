/**
 * Modify tools for any selection (Revit RO / MM / DM / AR / AL / OF) and
 * paste-at-cursor. Each operation is one APPLY_PATCH / MOVE_ELEMENTS (one
 * undo step); options (copy, count, distance…) come from modifyOptions.ts.
 *
 *   rotate — centre = selection centre (or click "Centre" and place it);
 *            click the start ray, then the end ray — or type an angle + Enter.
 *   mirror — pick a line (wall / grid / beam centreline) or draw an axis.
 *   array  — linear: click start and end of the step (or the whole span with
 *            "fit"), or type the distance; radial: click the centre.
 *   align  — pick a reference line (wall face / centreline, grid, column
 *            edge), then the element lines to bring onto it; Esc picks a new
 *            reference.
 *   offset — hover a wall / line: the copy (or the moved element) goes to the
 *            cursor's side at the typed distance.
 *   paste  — the clipboard follows the cursor; click to place.
 */
import type { ToolHandler, ToolContext, ToolStateSnapshot } from './types.ts';
import type { EditorAction, ModifyState, Tool } from '../state/editorTypes.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { toElementId, toSelectionId } from '../model/ids.ts';
import { typedKey, resolveTypedPoint } from './typedInput.ts';
import { getModifyOptions, setModifyOptions } from './modifyOptions.ts';
import { expandCopySet } from '../model/copySet.ts';
import { mirrorAcross, rotationAbout, transformElements, translation, type Xform } from '../model/transform.ts';
import {
  alignDelta, arrayPatch, canOffset, linearArrayTransforms, nearestAlignLine, offsetElement, offsetPatch, offsetSide,
  radialArrayTransforms, selectionCenter, transformPatch, type AlignLine,
} from '../model/modifyOps.ts';
import { nextGroupName, GROUP_TABLE } from '../model/groups.ts';
import { pasteElements, pasteNeedsTypesSaved, type ClipboardPayload } from '../model/clipboard.ts';

type Dispatch = (a: EditorAction) => void;

/** Max elements drawn as ghosts while a tool previews its result. */
const PREVIEW_CAP = 400;

export const SELECTION_TOOLS: ReadonlySet<Tool> = new Set(['rotate', 'mirror', 'array']);

function selRaw(state: ToolStateSnapshot): string[] {
  const doc = state.document;
  if (!doc) return [];
  return [...state.selectedIds].map(toElementId).filter(id => doc.elements.has(id));
}

/** Enter a modify tool from the toolbar, a shortcut or the selection bar. */
export function enterModifyToolFor(
  dispatch: Dispatch,
  state: { selectedIds: Set<string>; document: ToolStateSnapshot['document'] },
  tool: Tool,
  opts?: { mirrorMode?: 'pick' | 'draw' },
): boolean {
  if (opts?.mirrorMode) setModifyOptions({ mirrorMode: opts.mirrorMode });
  const doc = state.document;
  const ids = doc ? [...state.selectedIds].map(toElementId).filter(id => doc.elements.has(id)) : [];
  if (SELECTION_TOOLS.has(tool) && ids.length === 0) return false;
  const modify: ModifyState = {};
  if (tool === 'rotate' && doc) modify.center = selectionCenter(doc.elements, expandCopySet(doc.elements, ids)) ?? undefined;
  dispatch({ type: 'SET_TOOL', tool });
  dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify } });
  if (tool === 'align' || tool === 'offset') dispatch({ type: 'CLEAR_SELECTION' });
  return true;
}

function exitTool(ctx: ToolContext) {
  ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
  ctx.dispatch({ type: 'SET_HOVER', id: null });
  ctx.setSnap(null);
}

function snapped(ctx: ToolContext, e: { clientX: number; clientY: number }, anchor?: Point, exclude?: Set<string>): Point | null {
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (!raw) return null;
  const s = ctx.getState();
  const snap = snapPoint(raw, ctx.screenToSvg, s.document?.elements, exclude ?? new Set(selRaw(s)), anchor, undefined, s.grids,
    undefined, undefined, getProjectUnits(s), s.disabledSnapTypes);
  ctx.setSnap(snap);
  return snap.point;
}

function setModify(ctx: ToolContext, patch: Partial<ModifyState>, cursor?: Point | null, extra?: Record<string, unknown>) {
  const ds = ctx.getState().drawingState;
  ctx.dispatch({
    type: 'SET_DRAWING_STATE',
    state: { points: ds?.points ?? [], ...ds, ...(extra ?? {}), cursor: cursor !== undefined ? cursor : ds?.cursor ?? null, modify: { ...ds?.modify, ...patch } },
  });
}

/** Ghosts of the selection under each transform. */
function ghosts(state: ToolStateSnapshot, transforms: readonly Xform[]): CanonicalElement[] {
  const doc = state.document;
  if (!doc) return [];
  const set = [...expandCopySet(doc.elements, selRaw(state))].slice(0, PREVIEW_CAP);
  const out: CanonicalElement[] = [];
  for (const T of transforms) {
    for (const el of transformElements(doc.elements, set, T).values()) {
      out.push(el);
      if (out.length >= PREVIEW_CAP) return out;
    }
  }
  return out;
}

/** Commit a patch, select the result (whole groups) and go back to Select. */
function commit(ctx: ToolContext, description: string, r: { patch: Map<string, CanonicalElement | null>; select: string[] }, stay = false) {
  if (r.patch.size === 0) return;
  const s = ctx.getState();
  ctx.dispatch({ type: 'APPLY_PATCH', description, patches: r.patch });
  if (r.select.length) ctx.dispatch({ type: 'SELECT', ids: r.select.map(id => s.currentLevel ? toSelectionId(s.currentLevel, id) : id) });
  if (!stay) exitTool(ctx);
}

function escape(ctx: ToolContext, e: KeyboardEvent, back: () => boolean): boolean {
  if (e.key !== 'Escape') return false;
  if (!back()) exitTool(ctx);
  return true;
}

const deg = (v: Point) => Math.atan2(v.y, v.x) * 180 / Math.PI;

/** Whole degrees; multiples of 15° pull within 3°. */
function snapAngle(a: number): number {
  let x = ((a + 540) % 360) - 180;
  const m = Math.round(x / 15) * 15;
  if (Math.abs(x - m) <= 3) x = m;
  return Math.round(x);
}

// ─── Rotate ──────────────────────────────────────────────────────────────────

function rotateBy(ctx: ToolContext, angle: number) {
  const s = ctx.getState();
  const c = s.drawingState?.modify?.center;
  if (!s.document || !c || Math.abs(angle) < 1e-9) return;
  commit(ctx, 'Rotate', transformPatch(s.document.elements, selRaw(s), rotationAbout(c, angle), getModifyOptions().rotateCopy));
}

export const rotateTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerMove(ctx, e) {
    const s = ctx.getState();
    const m = s.drawingState?.modify;
    if (!m) return;
    const p = snapped(ctx, e, m.pickCenter ? undefined : m.center);
    if (!p) return;
    if (m.pickCenter || !m.center || !m.ref) { setModify(ctx, { preview: undefined }, p); return; }
    const angle = snapAngle(deg({ x: p.x - m.center.x, y: p.y - m.center.y }) - deg({ x: m.ref.x - m.center.x, y: m.ref.y - m.center.y }));
    setModify(ctx, { angle, preview: ghosts(s, [rotationAbout(m.center, angle)]) }, p);
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const s = ctx.getState();
    const m = s.drawingState?.modify;
    if (!m) return;
    const p = snapped(ctx, e, m.pickCenter ? undefined : m.center);
    if (!p) return;
    if (m.pickCenter || !m.center) { setModify(ctx, { center: p, pickCenter: false, ref: undefined, preview: undefined }, p); return; }
    if (!m.ref) {
      if (Math.hypot(p.x - m.center.x, p.y - m.center.y) < 1e-6) return;
      setModify(ctx, { ref: p }, p);
      return;
    }
    rotateBy(ctx, m.angle ?? 0);
  },
  onKeyDown(ctx, e) {
    const s = ctx.getState();
    const ds = s.drawingState;
    if (!ds?.modify) return false;
    // A typed angle: digits (and '-' once started), Enter applies
    const r = typedKey(e, ds.typed);
    if (r.handled && e.key !== 'Tab') {
      e.preventDefault();
      const value = parseFloat(r.typed?.length ?? '');
      if (r.commit && Number.isFinite(value)) { rotateBy(ctx, value); return true; }
      const c = ds.modify.center;
      const preview = c && Number.isFinite(value) ? ghosts(s, [rotationAbout(c, value)]) : undefined;
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, typed: r.typed, modify: { ...ds.modify, preview, angle: Number.isFinite(value) ? value : ds.modify.angle } } });
      return true;
    }
    return escape(ctx, e, () => {
      if (ds.modify?.ref || ds.modify?.pickCenter) { setModify(ctx, { ref: undefined, pickCenter: false, preview: undefined }); return true; }
      return false;
    });
  },
};

/** "Place centre" in the options bar. */
export function pickRotateCenter(dispatch: Dispatch, ds: ToolStateSnapshot['drawingState']) {
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, ...ds, modify: { ...ds?.modify, pickCenter: true, ref: undefined, preview: undefined } } });
}

// ─── Mirror ──────────────────────────────────────────────────────────────────

/** The centreline of the line element under the pointer (mirror axis pick). */
function lineUnder(ctx: ToolContext, e: { target: EventTarget | null }): { start: Point; end: Point } | null {
  const sid = ctx.findElementId(e.target);
  const el = sid ? ctx.getState().document?.elements.get(toElementId(sid)) : undefined;
  if (!el || (el.geometry !== 'line' && el.geometry !== 'spatial_line') || el.arc) return null;
  if (Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 1e-6) return null;
  return { start: el.start, end: el.end };
}

function mirrorOf(axis: { start: Point; end: Point }): Xform {
  return mirrorAcross(axis.start, { x: axis.end.x - axis.start.x, y: axis.end.y - axis.start.y });
}

function mirrorBy(ctx: ToolContext, axis: { start: Point; end: Point }) {
  const s = ctx.getState();
  if (!s.document) return;
  if (Math.hypot(axis.end.x - axis.start.x, axis.end.y - axis.start.y) < 1e-6) return;
  commit(ctx, 'Mirror', transformPatch(s.document.elements, selRaw(s), mirrorOf(axis), getModifyOptions().mirrorCopy));
}

export const mirrorTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerMove(ctx, e) {
    const s = ctx.getState();
    const m = s.drawingState?.modify;
    if (!m) return;
    if (getModifyOptions().mirrorMode === 'pick') {
      const axis = lineUnder(ctx, e);
      const p = ctx.screenToSvg(e.clientX, e.clientY);
      setModify(ctx, { hoverLine: axis ?? undefined, preview: axis ? ghosts(s, [mirrorOf(axis)]) : undefined }, p);
      return;
    }
    const p = snapped(ctx, e, m.ref);
    if (!p) return;
    const axis = m.ref ? { start: m.ref, end: p } : undefined;
    setModify(ctx, { axis, preview: axis && Math.hypot(p.x - m.ref!.x, p.y - m.ref!.y) > 1e-6 ? ghosts(s, [mirrorOf(axis)]) : undefined }, p);
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const s = ctx.getState();
    const m = s.drawingState?.modify;
    if (!m) return;
    if (getModifyOptions().mirrorMode === 'pick') {
      const axis = lineUnder(ctx, e);
      if (axis) mirrorBy(ctx, axis);
      return;
    }
    const p = snapped(ctx, e, m.ref);
    if (!p) return;
    if (!m.ref) { setModify(ctx, { ref: p }, p); return; }
    mirrorBy(ctx, { start: m.ref, end: p });
  },
  onKeyDown(ctx, e) {
    return escape(ctx, e, () => {
      const m = ctx.getState().drawingState?.modify;
      if (m?.ref) { setModify(ctx, { ref: undefined, axis: undefined, preview: undefined }); return true; }
      return false;
    });
  },
};

// ─── Array ───────────────────────────────────────────────────────────────────

function arrayTransforms(m: ModifyState, p: Point): Xform[] {
  const o = getModifyOptions();
  if (o.arrayMode === 'radial') return radialArrayTransforms(p, o.arrayCount, o.arrayAngle);
  if (!m.ref) return [];
  const v = { x: p.x - m.ref.x, y: p.y - m.ref.y };
  if (Math.hypot(v.x, v.y) < 1e-6) return [];
  return linearArrayTransforms(v, o.arrayCount, o.arrayFit);
}

function arrayAt(ctx: ToolContext, p: Point) {
  const s = ctx.getState();
  const m = s.drawingState?.modify;
  if (!s.document || !m) return;
  const Ts = arrayTransforms(m, p);
  if (Ts.length === 0) return;
  const o = getModifyOptions();
  const group = o.arrayGroup ? { name: nextGroupName(s.document.elements.values(), 'Array') } : undefined;
  commit(ctx, 'Array', arrayPatch(s.document.elements, selRaw(s), Ts, group));
}

export const arrayTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerMove(ctx, e) {
    const s = ctx.getState();
    const m = s.drawingState?.modify;
    if (!m) return;
    const p = snapped(ctx, e, m.ref);
    if (!p) return;
    const Ts = arrayTransforms(m, p);
    setModify(ctx, { preview: Ts.length ? ghosts(s, Ts) : undefined, axis: m.ref ? { start: m.ref, end: p } : undefined, center: getModifyOptions().arrayMode === 'radial' ? p : undefined }, p);
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const m = ctx.getState().drawingState?.modify;
    if (!m) return;
    const p = snapped(ctx, e, m.ref);
    if (!p) return;
    if (getModifyOptions().arrayMode === 'linear' && !m.ref) { setModify(ctx, { ref: p }, p); return; }
    arrayAt(ctx, p);
  },
  onKeyDown(ctx, e) {
    const s = ctx.getState();
    const ds = s.drawingState;
    const m = ds?.modify;
    if (!ds || !m) return false;
    if (m.ref && getModifyOptions().arrayMode === 'linear') {
      const r = typedKey(e, ds.typed);
      if (r.handled) {
        e.preventDefault();
        const target = r.commit && r.typed ? resolveTypedPoint(m.ref, ds.cursor, r.typed, getProjectUnits(s)) : null;
        if (target) arrayAt(ctx, target);
        else ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, typed: r.typed } });
        return true;
      }
    }
    return escape(ctx, e, () => {
      if (m.ref) { setModify(ctx, { ref: undefined, axis: undefined, preview: undefined }); return true; }
      return false;
    });
  },
};

// ─── Align ───────────────────────────────────────────────────────────────────

function lineSegment(l: AlignLine, el: CanonicalElement): { start: Point; end: Point } {
  // Long enough to read: the element's extent along the line, plus a margin
  const pts: Point[] = el.geometry === 'point' ? [el.position] : el.geometry === 'polygon' ? el.vertices : [el.start, el.end];
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const t = (p.x - l.p.x) * l.d.x + (p.y - l.p.y) * l.d.y;
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  const ext = el.geometry === 'point' ? Math.max(el.width, el.height) : 0;
  lo -= 1 + ext; hi += 1 + ext;
  return { start: { x: l.p.x + l.d.x * lo, y: l.p.y + l.d.y * lo }, end: { x: l.p.x + l.d.x * hi, y: l.p.y + l.d.y * hi } };
}

function elementUnder(ctx: ToolContext, e: { target: EventTarget | null }): CanonicalElement | null {
  const sid = ctx.findElementId(e.target);
  const el = sid ? ctx.getState().document?.elements.get(toElementId(sid)) : undefined;
  return el && el.tableName !== GROUP_TABLE ? el : null;
}

/** Reference picked in the first step (kept in the drawing state). */
const alignRef: { line: AlignLine | null } = { line: null };

export const alignTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerMove(ctx, e) {
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const el = elementUnder(ctx, e);
    if (!p) return;
    const ref = ctx.getState().drawingState?.pick ? alignRef.line : null;
    let line = el ? nearestAlignLine(el, p) : null;
    if (line && ref && !alignDelta(ref, line)) line = null;
    setModify(ctx, { hoverLine: line && el ? lineSegment(line, el) : undefined }, p);
    if ((el?.id ?? null) !== toElementId(ctx.getState().hoveredId ?? '')) ctx.dispatch({ type: 'SET_HOVER', id: el?.id ?? null });
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const el = elementUnder(ctx, e);
    const s = ctx.getState();
    if (!p || !el || !s.document) return;
    const line = nearestAlignLine(el, p);
    if (!line) return;
    if (!s.drawingState?.pick || !alignRef.line) {
      alignRef.line = line;
      const seg = lineSegment(line, el);
      setModify(ctx, { axis: seg, hoverLine: undefined }, p, { pick: { id: el.id, point: p, line: seg } });
      return;
    }
    const d = alignDelta(alignRef.line, line);
    if (!d) return;
    // A group member moves its whole instance
    const gid = el.attrs.group_id;
    const ids = gid ? [...s.document.elements.values()].filter(x => x.id === gid || x.attrs.group_id === gid).map(x => x.id) : [el.id];
    ctx.dispatch({ type: 'MOVE_ELEMENTS', ids, dx: d.x, dy: d.y });
  },
  onKeyDown(ctx, e) {
    return escape(ctx, e, () => {
      const ds = ctx.getState().drawingState;
      if (ds?.pick) {
        alignRef.line = null;
        ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: ds.cursor, modify: {} } });
        return true;
      }
      return false;
    });
  },
};

// ─── Offset ──────────────────────────────────────────────────────────────────

export const offsetTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerMove(ctx, e) {
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const el = elementUnder(ctx, e);
    if (!p) return;
    if (!canOffset(el)) { setModify(ctx, { preview: undefined }, p); return; }
    const shifted = offsetElement(el, getModifyOptions().offsetDistance, offsetSide(el, p));
    setModify(ctx, { preview: shifted ? [shifted] : undefined }, p);
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const el = elementUnder(ctx, e);
    const s = ctx.getState();
    if (!p || !s.document || !canOffset(el)) return;
    const o = getModifyOptions();
    const r = offsetPatch(s.document.elements, el.id, o.offsetDistance, offsetSide(el, p), o.offsetCopy);
    if (!r) return;
    if ('move' in r) ctx.dispatch({ type: 'MOVE_ELEMENTS', ids: [el.id], dx: r.move.x, dy: r.move.y });
    else ctx.dispatch({ type: 'APPLY_PATCH', description: 'Offset', patches: r.patch });
    setModify(ctx, { preview: undefined });
  },
  onKeyDown(ctx, e) {
    const ds = ctx.getState().drawingState;
    if (!ds) return false;
    // Typed digits set the distance (Enter applies it)
    const r = typedKey(e, ds.typed);
    if (r.handled && e.key !== 'Tab') {
      e.preventDefault();
      const v = parseFloat(r.typed?.length ?? '');
      if (r.commit && Number.isFinite(v) && v > 0) {
        setModifyOptions({ offsetDistance: v });
        ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, typed: undefined } });
      } else {
        ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...ds, typed: r.typed } });
      }
      return true;
    }
    return escape(ctx, e, () => false);
  },
};

// ─── Paste at cursor ─────────────────────────────────────────────────────────

/** The payload being placed (set by the clipboard handler before entering the tool). */
const pasting: { payload: ClipboardPayload | null } = { payload: null };

export function startPaste(dispatch: Dispatch, payload: ClipboardPayload) {
  pasting.payload = payload;
  dispatch({ type: 'SET_TOOL', tool: 'paste' });
  dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify: {} } });
}

/** Ids a pasted element must not reuse: the open level's, global/'s and the grids'. */
function takenIdsFor(s: ToolStateSnapshot): Set<string> {
  const taken = new Set<string>(s.document?.elements.keys() ?? []);
  for (const gl of s.project?.globalLayers ?? []) for (const id of gl.csvRows.keys()) taken.add(id);
  for (const g of s.grids) taken.add(g.id);
  return taken;
}

function pastePreview(p: ClipboardPayload, at: Point): CanonicalElement[] {
  const T = translation(at.x - p.base.x, at.y - p.base.y);
  const map = new Map(p.elements.slice(0, PREVIEW_CAP).map(e => [e.id, e]));
  return [...transformElements(map, map.keys(), T).values()];
}

export const pasteTool: ToolHandler = {
  cursor: 'copy',
  onPointerMove(ctx, e) {
    const p = pasting.payload;
    const at = snapped(ctx, e, undefined, new Set());
    if (!p || !at) return;
    setModify(ctx, { preview: pastePreview(p, at) }, at);
  },
  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = pasting.payload;
    const s = ctx.getState();
    const at = snapped(ctx, e, undefined, new Set());
    if (!p || !at || !s.document || !s.project) return;
    const { elements, selected } = pasteElements(p, s.currentLevel, s.project.levels, takenIdsFor(s), { x: at.x - p.base.x, y: at.y - p.base.y }, s.project.types);
    if (pasteNeedsTypesSaved(p, s.project.types)) ctx.dispatch({ type: 'SET_TYPES', types: { ...s.project.types!, saved: true, fromDisk: false } });
    commit(ctx, 'Paste', { patch: new Map(elements.map(el => [el.id, el])), select: selected });
    pasting.payload = null;
  },
  onKeyDown(ctx, e) {
    return escape(ctx, e, () => { pasting.payload = null; return false; });
  },
};
