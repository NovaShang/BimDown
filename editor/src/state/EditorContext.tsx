import { createContext, useContext, useReducer, useMemo, type ReactNode, type Dispatch } from 'react';
import type { EditorState, EditorAction } from './editorTypes.ts';
import { editorReducer, initialState } from './editorReducer.ts';
import { syncAnnotations } from '../annotation/sync.ts';
import { toElementId } from '../model/ids.ts';

/** Selection-only slice — changes here do NOT trigger re-renders in document consumers. */
interface SelectionState {
  /** Raw selection IDs (may carry a "levelId:" prefix in multi-floor mode). */
  selectedIds: Set<string>;
  /** Raw element IDs after stripping level prefix — for fast per-element
   *  `selectedRawIds.has(element.id)` checks in render paths. */
  selectedRawIds: Set<string>;
  hoveredId: string | null;
  /** Raw hovered element ID (level prefix stripped), or null. */
  hoveredRawId: string | null;
}

const StateContext = createContext<EditorState>(initialState);
const CoreStateContext = createContext<EditorState>(initialState);
const SelectionContext = createContext<SelectionState>({
  selectedIds: new Set(), selectedRawIds: new Set(), hoveredId: null, hoveredRawId: null,
});
const DispatchContext = createContext<Dispatch<EditorAction>>(() => {});

/** The editor reducer plus the annotation associativity pass. */
const MUTATION_LOG_SIZE = 64;

export function rootReducer(state: EditorState, action: EditorAction): EditorState {
  const next = syncAnnotations(state, editorReducer(state, action), action);
  // Keep every mutation, not only the last: two dispatched in one event (or
  // before the autosave effect runs) must both reach the file writer.
  if (action.type === 'INIT_DOCUMENT') return next.mutationLog?.length ? { ...next, mutationLog: [] } : next;
  if (next.lastMutation && next.lastMutation !== state.lastMutation) {
    return { ...next, mutationLog: [...(state.mutationLog ?? []).slice(-(MUTATION_LOG_SIZE - 1)), next.lastMutation] };
  }
  return next;
}

/** Keys of every logged mutation newer than `after` (the last version saved), and the newest version. */
export function unsavedMutationKeys(state: Pick<EditorState, 'mutationLog' | 'lastMutation'>, after: number): { keys: Set<string>; version: number } {
  const keys = new Set<string>();
  let version = after;
  for (const m of state.mutationLog ?? (state.lastMutation ? [state.lastMutation] : [])) {
    if (m.version <= after) continue;
    for (const k of m.keys) keys.add(k);
    version = Math.max(version, m.version);
  }
  return { keys, version };
}

export function EditorProvider({ children, readonly }: { children: ReactNode; readonly?: boolean }) {
  const [state, dispatch] = useReducer(rootReducer, { ...initialState, readonly: readonly ?? false });

  // Stable selection reference — only changes when selectedIds/hoveredId actually change.
  // selectedRawIds is pre-computed here so per-element render paths can do an
  // O(1) `has(element.id)` check without rebuilding the raw set per node.
  const selection = useMemo<SelectionState>(() => {
    const selectedRawIds = new Set<string>();
    for (const sid of state.selectedIds) selectedRawIds.add(toElementId(sid));
    return {
      selectedIds: state.selectedIds,
      selectedRawIds,
      hoveredId: state.hoveredId,
      hoveredRawId: state.hoveredId !== null ? toElementId(state.hoveredId) : null,
    };
  }, [state.selectedIds, state.hoveredId]);

  // Core state — excludes hoveredId so high-frequency hover events don't trigger
  // re-renders in heavy components like Canvas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const coreState = useMemo(() => state, [
    state.modelName, state.project, state.grids, state.loading,
    state.currentLevel, state.viewMode, state.floor3DMode,
    state.readonly, state.visibleLayers, state.showGrid, state.showMinimap, state.disabledSnapTypes,
    state.activeTool, state.previousTool, state.activeFilter, state.activeDiscipline, state.showArchContext, state.viewOptions, state.spaceHeld,
    state.selectedIds, state.marquee,
    state.document, state.history, state.editMode,
    state.drawingTarget, state.drawingAttrs, state.drawingState,
    state.documentVersion, state.lastMutation, state.views,
  ]);

  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>
        <CoreStateContext.Provider value={coreState}>
          <SelectionContext.Provider value={selection}>
            {children}
          </SelectionContext.Provider>
        </CoreStateContext.Provider>
      </StateContext.Provider>
    </DispatchContext.Provider>
  );
}

/** Full editor state — re-renders on ANY state change including hover.
 *  Prefer useCoreEditorState() for heavy render trees, or useSelectionState()
 *  for components that only need highlight info. */
export function useEditorState() {
  return useContext(StateContext);
}

/** Core editor state — same as useEditorState() but does NOT re-render on hoveredId changes.
 *  Use this in expensive components (Canvas, etc.) and handle hover via useSelectionState(). */
export function useCoreEditorState() {
  return useContext(CoreStateContext);
}

/** Selection-only state — only re-renders when selectedIds or hoveredId changes. */
export function useSelectionState() {
  return useContext(SelectionContext);
}

export function useEditorDispatch() {
  return useContext(DispatchContext);
}
