/**
 * Revit commands on the selection: CS (create similar), MA (match type
 * properties) and temporary hide / isolate (HH, HI, HC, IC, HR).
 */
import type { EditorAction, EditorState } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { toElementId } from '../model/ids.ts';
import { retypeElements } from './typeEdits.ts';
import { applyTempHide, setTempHide } from './tempHide.ts';

type Dispatch = (a: EditorAction) => void;

function selected(state: EditorState): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  for (const sid of state.selectedIds) {
    const el = state.document?.elements.get(toElementId(sid));
    if (el) out.push(el);
  }
  return out;
}

/** The table and type a Create Similar of the selection places; null when it has none. */
export function similarOf(state: EditorState): { tableName: string; typeId: string } | null {
  const el = selected(state)[0];
  return el ? { tableName: el.tableName, typeId: el.attrs.type_id ?? '' } : null;
}

/**
 * Match type properties: the first selected element is the source, every
 * other selected element of its category takes its type. Returns how many changed.
 */
export function matchType(state: EditorState, dispatch: Dispatch): number {
  const els = selected(state);
  const doc = state.document;
  if (!doc || els.length < 2) return 0;
  const src = els[0];
  const targets = els.slice(1).filter(e => e.tableName === src.tableName).map(e => e.id);
  const { changed } = retypeElements(doc.elements, targets, src.attrs.type_id ?? '', state.project?.types);
  if (changed.size === 0) return 0;
  const patches = new Map<string, CanonicalElement>();
  for (const [id, c] of changed) patches.set(id, c.after);
  dispatch({ type: 'APPLY_PATCH', description: 'Match type', patches });
  return changed.size;
}

/** Temporarily hide / isolate the selected elements or their categories. */
export function tempHideSelection(state: EditorState, mode: 'hide' | 'isolate', by: 'element' | 'category'): boolean {
  const els = selected(state);
  if (els.length === 0) return false;
  if (by === 'element') applyTempHide(mode, els.map(e => e.id), []);
  else applyTempHide(mode, [], [...new Set(els.map(e => `${e.discipline}/${e.tableName}`))]);
  return true;
}

export function resetTempHide() {
  setTempHide(null);
}
