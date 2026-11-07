/**
 * Selection helpers (Revit: Select All Instances, select by system, the
 * selection filter, pin / group commands) shared by the context menu, the
 * selection bar and the two-letter shortcuts.
 */
import type { EditorAction, EditorState } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { toElementId, toSelectionId } from '../model/ids.ts';
import { isBackgroundDiscipline } from './selectors.ts';
import { isPinned } from '../model/pins.ts';
import { createGroupPatch, GROUP_TABLE, nextGroupName, ungroupPatch } from '../model/groups.ts';
import { takenIds, levelElements } from './levelEdits.ts';

type Dispatch = (a: EditorAction) => void;

export function selectedElements(state: Pick<EditorState, 'selectedIds' | 'document'>): CanonicalElement[] {
  const doc = state.document;
  if (!doc) return [];
  const out: CanonicalElement[] = [];
  for (const sid of state.selectedIds) {
    const el = doc.elements.get(toElementId(sid));
    if (el) out.push(el);
  }
  return out;
}

const sel = (state: EditorState, ids: string[]) => ids.map(id => state.currentLevel ? toSelectionId(state.currentLevel, id) : id);

/** "Same type": table + type_id, or family + type (library elements), or just the table. */
export function instanceKey(el: CanonicalElement): string {
  const a = el.attrs;
  const sub = a.type_id ? `type:${a.type_id}` : a.family || a.type ? `fam:${a.family ?? ''}/${a.type ?? ''}` : '';
  return `${el.tableName}|${sub}`;
}

function isVisible(state: EditorState, el: CanonicalElement): boolean {
  return state.visibleLayers.has(`${el.discipline}/${el.tableName}`)
    && !isBackgroundDiscipline(el.discipline, state.activeDiscipline, el.tableName);
}

/**
 * Select every element of the selected elements' types: visible in the view,
 * or on the whole level (hidden layers too). Returns how many more there are
 * on other levels (the plan edits one level at a time).
 */
export function selectAllInstances(state: EditorState, dispatch: Dispatch, scope: 'view' | 'project'): { selected: number; elsewhere: number } {
  const doc = state.document;
  if (!doc) return { selected: 0, elsewhere: 0 };
  const keys = new Set(selectedElements(state).filter(e => e.tableName !== GROUP_TABLE).map(instanceKey));
  if (keys.size === 0) return { selected: 0, elsewhere: 0 };
  const ids: string[] = [];
  for (const el of doc.elements.values()) {
    if (!keys.has(instanceKey(el))) continue;
    if (scope === 'view' && !isVisible(state, el)) continue;
    ids.push(el.id);
  }
  let elsewhere = 0;
  if (scope === 'project') {
    for (const level of state.project?.levels ?? []) {
      if (level.id === doc.levelId) continue;
      for (const el of levelElements(state, level.id).values()) if (keys.has(instanceKey(el))) elsewhere++;
    }
  }
  dispatch({ type: 'SELECT', ids: sel(state, ids), exact: true });
  return { selected: ids.length, elsewhere };
}

/** MEP: every element of the selected elements' systems (system_type). */
export function selectBySystem(state: EditorState, dispatch: Dispatch): number {
  const doc = state.document;
  if (!doc) return 0;
  const systems = new Set(selectedElements(state).map(e => (e.attrs.system_type ?? '').trim()).filter(Boolean));
  if (systems.size === 0) return 0;
  const ids: string[] = [];
  for (const el of doc.elements.values()) if (systems.has((el.attrs.system_type ?? '').trim())) ids.push(el.id);
  dispatch({ type: 'SELECT', ids: sel(state, ids), exact: true });
  return ids.length;
}

export function selectionHasSystem(state: EditorState): boolean {
  return selectedElements(state).some(e => (e.attrs.system_type ?? '').trim() !== '');
}

/** Selection by table with counts (selection filter dialog). */
export function selectionCategories(state: EditorState): { table: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const el of selectedElements(state)) counts.set(el.tableName, (counts.get(el.tableName) ?? 0) + 1);
  return [...counts].map(([table, count]) => ({ table, count })).sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
}

export function filterSelection(state: EditorState, dispatch: Dispatch, keep: ReadonlySet<string>) {
  const ids = [...state.selectedIds].filter(sid => {
    const el = state.document?.elements.get(toElementId(sid));
    return el && keep.has(el.tableName);
  });
  dispatch({ type: 'SELECT', ids, exact: true });
}

// ─── Pin / group ─────────────────────────────────────────────────────────────

export function allPinned(state: EditorState): boolean {
  const els = selectedElements(state).filter(e => e.tableName !== GROUP_TABLE);
  return els.length > 0 && els.every(isPinned);
}

export function setPinned(state: EditorState, dispatch: Dispatch, pinned: boolean) {
  const ids = selectedElements(state).filter(e => e.tableName !== GROUP_TABLE && e.tableName !== 'connector').map(e => e.id);
  if (ids.length) dispatch({ type: 'UPDATE_ATTRS_MANY', ids, attrs: { pinned: pinned ? 'true' : '' } });
}

/** The one model group the selection is (all of one instance), if any. */
export function selectedGroup(state: EditorState): CanonicalElement | null {
  const rows = selectedElements(state).filter(e => e.tableName === GROUP_TABLE);
  return rows.length === 1 ? rows[0] : null;
}

export function createGroup(state: EditorState, dispatch: Dispatch): string | null {
  const doc = state.document;
  if (!doc) return null;
  const ids = selectedElements(state).map(e => e.id);
  const g = createGroupPatch(doc.elements, ids, nextGroupName(doc.elements.values()), takenIds(state, doc.levelId));
  if (!g) return null;
  dispatch({ type: 'APPLY_PATCH', description: 'Create group', patches: g.patch });
  dispatch({ type: 'SELECT', ids: sel(state, [g.groupId]) });
  return g.groupId;
}

export function ungroup(state: EditorState, dispatch: Dispatch) {
  const doc = state.document;
  const row = selectedGroup(state);
  if (!doc || !row) return;
  const members = [...doc.elements.values()].filter(e => e.attrs.group_id === row.id).map(e => e.id);
  dispatch({ type: 'APPLY_PATCH', description: 'Ungroup', patches: ungroupPatch(doc.elements, row.id) });
  dispatch({ type: 'SELECT', ids: sel(state, members), exact: true });
}

/** While editing a group: the selected elements join it. */
export function addToEditedGroup(state: EditorState, dispatch: Dispatch) {
  const ge = state.groupEdit;
  if (!ge) return;
  const patches = new Map<string, CanonicalElement | null>();
  for (const el of selectedElements(state)) {
    if (el.attrs.group_id === ge.groupId || el.tableName === GROUP_TABLE || el.tableName === 'connector') continue;
    patches.set(el.id, { ...el, attrs: { ...el.attrs, group_id: ge.groupId } });
  }
  if (patches.size) dispatch({ type: 'APPLY_PATCH', description: 'Add to group', patches });
}

/** While editing a group: the selected members leave it. */
export function removeFromEditedGroup(state: EditorState, dispatch: Dispatch) {
  const ge = state.groupEdit;
  if (!ge) return;
  const patches = new Map<string, CanonicalElement | null>();
  for (const el of selectedElements(state)) {
    if (el.attrs.group_id !== ge.groupId) continue;
    const attrs = { ...el.attrs };
    delete attrs.group_id;
    patches.set(el.id, { ...el, attrs });
  }
  if (patches.size) dispatch({ type: 'APPLY_PATCH', description: 'Remove from group', patches });
}
