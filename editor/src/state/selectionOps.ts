/**
 * Selection helpers (Revit: Select All Instances, select by system, the
 * selection filter, pin / group commands) shared by the context menu, the
 * selection bar and the two-letter shortcuts.
 */
import type { EditorAction, EditorState } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { toElementId, toSelectionId } from '../model/ids.ts';
import { isLayerSelectableInView } from './selectors.ts';
import { isPinned } from '../model/pins.ts';
import { createGroupPatch, GROUP_TABLE, nextGroupName, ungroupPatch } from '../model/groups.ts';
import { takenIds, levelElements, type LevelPatches } from './levelEdits.ts';
import { flipWalls } from './typeEdits.ts';

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

/**
 * Whether an element can be picked in the current view: its layer is on and
 * drawn in the active discipline, and not as background context (architecture
 * under MEP, grids under architecture…). Click, marquee, Select All and
 * "Select all instances in view" agree on this.
 */
export function isInteractiveInView(state: EditorState, el: CanonicalElement): boolean {
  if (el.tableName === 'connector' || el.attrs.view_id) return false;
  return isLayerSelectableInView(el.discipline, el.tableName, state);
}

const isVisible = isInteractiveInView;

/** ⌘A: every element of the open level that the current view lets you pick (selection ids). */
export function selectAllInView(state: EditorState): string[] {
  const doc = state.document;
  if (!doc) return [];
  const ids: string[] = [];
  for (const el of doc.elements.values()) if (isInteractiveInView(state, el)) ids.push(el.id);
  return sel(state, ids);
}

/** More than this many elements deleted at once asks first. */
export const DELETE_CONFIRM_THRESHOLD = 50;

/**
 * What a Delete of `ids` would remove, when it should be confirmed: many
 * elements, or some the view doesn't show (hidden layers, another
 * discipline, other levels of a project-wide selection). Null = delete at once.
 */
export function deleteConfirmation(state: EditorState, ids: readonly string[]): { count: number; hidden: number } | null {
  const doc = state.document;
  let count = 0, hidden = 0;
  for (const sid of ids) {
    const el = doc?.elements.get(toElementId(sid));
    if (!el) continue;
    count++;
    if (!isInteractiveInView(state, el)) hidden++;
  }
  for (const raw of state.projectSelection?.values() ?? []) { count += raw.length; hidden += raw.length; }
  return count > DELETE_CONFIRM_THRESHOLD || hidden > 0 ? { count, hidden } : null;
}

type DeleteRequest = { ids: string[]; count: number; hidden: number; dispatch: Dispatch };
let pendingDelete: DeleteRequest | null = null;
const deleteListeners = new Set<() => void>();
const emitDelete = () => { for (const l of deleteListeners) l(); };

/** The Delete key / button / menu: deletes, or asks first (see deleteConfirmation). */
export function requestDelete(state: EditorState, dispatch: Dispatch, ids: readonly string[] = [...state.selectedIds]) {
  if (state.readonly || ids.length === 0) return;
  const ask = deleteConfirmation(state, ids);
  if (!ask) { dispatch({ type: 'DELETE_ELEMENTS', ids: [...ids] }); return; }
  pendingDelete = { ids: [...ids], ...ask, dispatch };
  emitDelete();
}

export const pendingDeleteStore = {
  subscribe(l: () => void) { deleteListeners.add(l); return () => { deleteListeners.delete(l); }; },
  get: () => pendingDelete,
  confirm() {
    const p = pendingDelete;
    pendingDelete = null;
    emitDelete();
    if (p) p.dispatch({ type: 'DELETE_ELEMENTS', ids: p.ids });
  },
  cancel() { pendingDelete = null; emitDelete(); },
};

/**
 * Select every element of the selected elements' types: visible in the view,
 * or in the whole project (hidden layers and every level; the other levels'
 * instances are held as the project selection). Returns how many are on other levels.
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
  const others = new Map<string, string[]>();
  if (scope === 'project') {
    for (const level of state.project?.levels ?? []) {
      if (level.id === doc.levelId) continue;
      const found: string[] = [];
      for (const el of levelElements(state, level.id).values()) if (keys.has(instanceKey(el))) found.push(el.id);
      if (found.length) { others.set(level.id, found); elsewhere += found.length; }
    }
  }
  dispatch({ type: 'SELECT', ids: sel(state, ids), exact: true });
  // The other levels' instances join the selection for Delete / Change type / properties
  if (others.size) dispatch({ type: 'SET_PROJECT_SELECTION', levels: others });
  return { selected: ids.length, elsewhere };
}

/** How many elements a project-wide selection holds on other levels. */
export function selectedElsewhere(state: Pick<EditorState, 'projectSelection'>): number {
  let n = 0;
  for (const raw of state.projectSelection?.values() ?? []) n += raw.length;
  return n;
}

/** Flip the selected walls, on every level of a project-wide selection (one undo step). */
export function flipSelectedWalls(state: EditorState, dispatch: Dispatch) {
  const doc = state.document;
  if (!doc) return;
  const local = flipWalls(doc.elements, [...state.selectedIds].map(toElementId));
  if (!state.projectSelection) {
    if (local.size > 0) dispatch({ type: 'APPLY_PATCH', description: 'Flip wall', patches: local });
    return;
  }
  const patches: LevelPatches = new Map([[doc.levelId, local]]);
  for (const [levelId, raw] of state.projectSelection) {
    if (levelId !== doc.levelId) patches.set(levelId, flipWalls(levelElements(state, levelId), raw));
  }
  dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Flip wall', patches });
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
