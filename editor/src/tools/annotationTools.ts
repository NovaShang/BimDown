/**
 * Annotation tools: dimension (pick references, chain, wall run), text and
 * tag. Transient picking state lives in `annotationToolState`; every change
 * dispatches SET_DRAWING_STATE so the canvas overlay re-renders.
 */
import type { ToolHandler, ToolContext } from './types.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import type { CanonicalElement, LineElement, PointElement, Point } from '../model/elements.ts';
import { generateId, toElementId } from '../model/ids.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { ANNOTATION_DISCIPLINE, isAnnotationTable } from '../annotation/model.ts';
import { pickReference, chainDirection, chainRows, wallRunPicks, dimensionElements, type PickedRef, type DimMode } from '../annotation/pick.ts';
import { thicknessOf, sub, mul, dot, len, add, metre } from '../annotation/geometry.ts';

export const annotationToolState = {
  /** Dimension tool: references picked so far. */
  picks: [] as PickedRef[],
  /** Dimension tool: reference under the cursor. */
  hover: null as PickedRef | null,
  /** Text tool: where the text box is open (model + screen coords). */
  pendingText: null as { point: Point; client: { x: number; y: number } } | null,
  /** Tag tool: taggable element under the cursor. */
  hoverTagId: null as string | null,
  reset() {
    this.picks = [];
    this.hover = null;
    this.pendingText = null;
    this.hoverTagId = null;
  },
};

/** Model units per screen pixel. */
function pxToModel(ctx: ToolContext, e: React.PointerEvent): number {
  const a = ctx.screenToSvg(e.clientX, e.clientY);
  const b = ctx.screenToSvg(e.clientX + 10, e.clientY);
  return a && b ? Math.abs(b.x - a.x) / 10 : 0.02;
}

function refresh(ctx: ToolContext, cursor: Point | null) {
  ctx.dispatch({
    type: 'SET_DRAWING_STATE',
    state: { points: annotationToolState.picks.map(p => p.point), cursor },
  });
}

function lookupFor(ctx: ToolContext) {
  const els = ctx.getState().document?.elements;
  return (id: string) => els?.get(id);
}

/** Place the picked chain as dimension rows with the line through `cursor`. */
export function placeDimensions(
  dispatch: (action: EditorAction) => void,
  elements: Map<string, CanonicalElement> | undefined,
  mode: DimMode,
  cursor: Point,
): boolean {
  const picks = annotationToolState.picks;
  if (picks.length < 2 || !elements) return false;
  const rows = chainRows(picks, cursor, chainDirection(picks, cursor, mode));
  annotationToolState.picks = [];
  if (rows.length > 0) {
    dispatch({
      type: 'CREATE_ELEMENTS',
      elements: dimensionElements(rows, elements.keys()),
      description: 'Add dimension',
      selectPrimary: false,
    });
  }
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor } });
  return rows.length > 0;
}

function wallRun(ctx: ToolContext, p: Point, tol: number): void {
  const state = ctx.getState();
  const elements = state.document?.elements;
  if (!elements) return;
  const lookup = lookupFor(ctx);
  const hit = pickReference(p, [...elements.values()].filter(e => ['wall', 'structure_wall', 'curtain_wall'].includes(e.tableName)), tol, lookup);
  const wall = hit ? elements.get(hit.elementId) : undefined;
  if (!wall || wall.geometry !== 'line') return;
  const ln = wall as LineElement;
  const L = len(sub(ln.end, ln.start));
  if (L < 1e-6) return;
  const u = mul(sub(ln.end, ln.start), 1 / L);
  const n = { x: -u.y, y: u.x };
  const side = dot(sub(p, ln.start), n) >= 0 ? 1 : -1;
  // Dimension line 0.8 m off the face on the clicked side
  const cursor = add(ln.start, mul(n, side * (thicknessOf(ln, lookup) / 2 + 0.8 * metre())));
  const picks = wallRunPicks(ln, elements.values(), lookup);
  const rows = chainRows(picks, cursor, Math.atan2(u.y, u.x) * 180 / Math.PI);
  if (rows.length === 0) return;
  ctx.dispatch({
    type: 'CREATE_ELEMENTS',
    elements: dimensionElements(rows, elements.keys()),
    description: 'Dimension wall',
    selectPrimary: false,
  });
}

export const drawDimensionTool: ToolHandler = {
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const state = ctx.getState();
    if (!p || !state.document) return;
    const tol = 8 * pxToModel(ctx, e);
    if (state.drawingAttrs.dim_mode === 'wall_run') {
      wallRun(ctx, p, tol);
      return;
    }
    if ((state.drawingState?.points.length ?? 0) === 0) annotationToolState.picks = [];
    const picks = annotationToolState.picks;
    const hover = pickReference(p, state.document.elements.values(), tol, lookupFor(ctx));
    if (hover) {
      if (!picks.some(k => k.ref === hover.ref && len(sub(k.point, hover.point)) < 1e-6)) picks.push(hover);
    } else if (picks.length >= 2) {
      placeDimensions(ctx.dispatch, state.document.elements, (state.drawingAttrs.dim_mode || 'aligned') as DimMode, p);
      return;
    } else {
      // No reference here: a fixed point (snapped)
      const snap = snapPoint(p, ctx.screenToSvg, state.document.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
      picks.push({ ref: '', point: snap.point, elementId: '' });
    }
    refresh(ctx, p);
  },

  onPointerMove(ctx, e) {
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const state = ctx.getState();
    if (!p || !state.document) return;
    const tol = 8 * pxToModel(ctx, e);
    const els = state.drawingAttrs.dim_mode === 'wall_run'
      ? [...state.document.elements.values()].filter(x => ['wall', 'structure_wall', 'curtain_wall'].includes(x.tableName))
      : state.document.elements.values();
    annotationToolState.hover = pickReference(p, els, tol, lookupFor(ctx));
    // Picks reset by Esc / right-click (drawing state cleared) → forget them
    if ((state.drawingState?.points.length ?? 0) === 0 && annotationToolState.picks.length > 0) annotationToolState.picks = [];
    refresh(ctx, p);
  },
};

export const drawTextTool: ToolHandler = {
  cursor: 'text',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    const state = ctx.getState();
    if (!p || !state.document) return;
    const snap = snapPoint(p, ctx.screenToSvg, state.document.elements, undefined, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
    annotationToolState.pendingText = { point: snap.point, client: { x: e.clientX, y: e.clientY } };
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [snap.point], cursor: snap.point } });
  },

  onPointerMove(ctx, e) {
    if (annotationToolState.pendingText) return;
    const p = ctx.screenToSvg(e.clientX, e.clientY);
    if (p) ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p } });
  },
};

/** Elements a tag can label. */
export function isTaggable(el: CanonicalElement | undefined): el is CanonicalElement {
  if (!el || isAnnotationTable(el.tableName)) return false;
  return !['grid', 'connector', 'mep_node', 'room_separator'].includes(el.tableName);
}

export function newTag(host: CanonicalElement, content: string, existingIds: Iterable<string>): PointElement {
  const id = generateId('tag', new Set(existingIds));
  return {
    geometry: 'point', id, tableName: 'tag', discipline: ANNOTATION_DISCIPLINE,
    position: { x: 0, y: 0 }, width: 0.3, height: 0.3,
    attrs: { host_id: host.id, x: '', y: '', content: content || 'auto' },
  };
}

/** Tags for every untagged element of `tables` on the level (one undo step). */
export function tagAllElements(elements: Map<string, CanonicalElement>, tables: string[], content = 'auto'): PointElement[] {
  const tagged = new Set<string>();
  for (const el of elements.values()) if (el.tableName === 'tag') tagged.add(el.attrs.host_id ?? '');
  const ids = new Set(elements.keys());
  const out: PointElement[] = [];
  for (const el of elements.values()) {
    if (!tables.includes(el.tableName) || tagged.has(el.id)) continue;
    const tag = newTag(el, content, ids);
    ids.add(tag.id);
    out.push(tag);
  }
  return out;
}

function taggableUnder(ctx: ToolContext, e: React.PointerEvent): CanonicalElement | undefined {
  const sid = ctx.findElementId(e.target);
  if (!sid || sid.startsWith('global:')) return undefined;
  const el = ctx.getState().document?.elements.get(toElementId(sid));
  return isTaggable(el) ? el : undefined;
}

export const drawTagTool: ToolHandler = {
  cursor: 'copy',

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    const state = ctx.getState();
    const host = taggableUnder(ctx, e);
    if (!host || !state.document) return;
    const already = [...state.document.elements.values()].some(t => t.tableName === 'tag' && t.attrs.host_id === host.id);
    if (already) return;
    ctx.dispatch({ type: 'CREATE_ELEMENT', element: newTag(host, state.drawingAttrs.content ?? 'auto', state.document.elements.keys()) });
  },

  onPointerMove(ctx, e) {
    const host = taggableUnder(ctx, e);
    const id = host ? host.id : null;
    if (id === annotationToolState.hoverTagId) return;
    annotationToolState.hoverTagId = id;
    const level = ctx.getState().currentLevel;
    ctx.dispatch({ type: 'SET_HOVER', id: id ? `${level}:${id}` : null });
  },
};
