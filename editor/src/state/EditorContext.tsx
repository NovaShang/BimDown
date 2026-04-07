import { createContext, useContext, useReducer, useMemo, type ReactNode, type Dispatch } from 'react';
import type { EditorState, EditorAction } from './editorTypes.ts';
import { editorReducer, initialState } from './editorReducer.ts';

/** Selection-only slice — changes here do NOT trigger re-renders in document consumers. */
interface SelectionState {
  selectedIds: Set<string>;
  hoveredId: string | null;
}

const StateContext = createContext<EditorState>(initialState);
const CoreStateContext = createContext<EditorState>(initialState);
const SelectionContext = createContext<SelectionState>({ selectedIds: new Set(), hoveredId: null });
const DispatchContext = createContext<Dispatch<EditorAction>>(() => {});

export function EditorProvider({ children, readonly }: { children: ReactNode; readonly?: boolean }) {
  const [state, dispatch] = useReducer(editorReducer, { ...initialState, readonly: readonly ?? false });

  // Stable selection reference — only changes when selectedIds/hoveredId actually change
  const selection = useMemo<SelectionState>(
    () => ({ selectedIds: state.selectedIds, hoveredId: state.hoveredId }),
    [state.selectedIds, state.hoveredId],
  );

  // Core state — excludes hoveredId so high-frequency hover events don't trigger
  // re-renders in heavy components like Canvas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const coreState = useMemo(() => state, [
    state.modelName, state.project, state.grids, state.loading,
    state.currentLevel, state.viewMode, state.floor3DMode,
    state.readonly, state.visibleLayers, state.showGrid, state.showMinimap,
    state.activeTool, state.previousTool, state.activeFilter, state.activeDiscipline, state.spaceHeld,
    state.selectedIds, state.marquee,
    state.document, state.history, state.editMode,
    state.drawingTarget, state.drawingAttrs, state.drawingState,
    state.documentVersion, state.lastMutation,
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
