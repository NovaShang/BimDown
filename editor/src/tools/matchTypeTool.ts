/**
 * Match Type Properties (Revit MA): pick the source, then click targets one
 * after another; each target of the source's category takes the source's
 * type (state/revitCommands.ts matchTypeOnto), one undo step per click. The
 * tool stays active until Esc or a right-click. Entered with one element
 * selected, that element is the source.
 */
import type { ToolContext, ToolHandler } from './types.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import { toElementId } from '../model/ids.ts';
import { matchTypeOnto } from '../state/revitCommands.ts';
import { showNotice } from '../state/modifyUi.ts';
import { picksAt } from './selectTool.ts';

/** Start the pick flow; `sourceSid` = the selected source (selection id), else the first click picks it. */
export function enterMatchType(dispatch: (a: EditorAction) => void, sourceSid?: string | null) {
  dispatch({ type: 'SET_TOOL', tool: 'match_type' });
  dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  dispatch({
    type: 'SET_DRAWING_STATE',
    state: { points: [], cursor: null, pick: sourceSid ? { id: toElementId(sourceSid), point: { x: 0, y: 0 } } : undefined },
  });
  if (sourceSid) dispatch({ type: 'SELECT', ids: [sourceSid] });
  else dispatch({ type: 'CLEAR_SELECTION' });
}

/** Selection id of the element under the pointer (2D picks, else the 3D raycast). */
function pickedAt(ctx: ToolContext, e: { clientX: number; clientY: number }): string | null {
  const hit = picksAt(ctx, e.clientX, e.clientY)[0];
  if (hit) return hit.sid;
  return ctx.screenToScenePoint?.(e.clientX, e.clientY)?.elementId ?? null;
}

function exit(ctx: ToolContext) {
  ctx.dispatch({ type: 'SET_TOOL', tool: 'select' });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: null });
  ctx.dispatch({ type: 'SET_HOVER', id: null });
}

export const matchTypeTool: ToolHandler = {
  cursor: 'copy',
  onPointerDown(ctx, e) {
    if (e.button !== 0) return; // right-click ends the tool (Canvas context menu handler)
    const sid = pickedAt(ctx, e);
    if (!sid) return;
    const state = ctx.getState();
    const doc = state.document;
    if (!doc) return;
    const pick = state.drawingState?.pick;
    if (!pick) {
      const id = toElementId(sid);
      if (!doc.elements.has(id)) return;
      ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, pick: { id, point: { x: 0, y: 0 } } } });
      ctx.dispatch({ type: 'SELECT', ids: [sid] });
      return;
    }
    const r = matchTypeOnto(doc.elements, pick.id, toElementId(sid), state.project?.types);
    if (r.ok) ctx.dispatch({ type: 'APPLY_PATCH', description: 'Match type', patches: r.patches });
    else if (r.reason === 'incompatible') showNotice('notice.matchIncompatible');
    else if (r.reason === 'untyped') showNotice('notice.matchUntyped');
  },
  onPointerMove(ctx, e) {
    const state = ctx.getState();
    const sid = pickedAt(ctx, e);
    const pick = state.drawingState?.pick;
    // Before the source: any element; after: only targets of the source's category.
    let next: string | null = sid;
    if (sid && pick) {
      const src = state.document?.elements.get(pick.id), dst = state.document?.elements.get(toElementId(sid));
      if (!src || !dst || dst.tableName !== src.tableName || dst.id === src.id) next = null;
    }
    if (next !== state.hoveredId) ctx.dispatch({ type: 'SET_HOVER', id: next });
  },
  onKeyDown(ctx, e) {
    if (e.key !== 'Escape') return false;
    exit(ctx);
    return true;
  },
};
