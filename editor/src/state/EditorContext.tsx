import { createContext, useContext, useReducer, useMemo, type ReactNode, type Dispatch } from 'react';
import type { EditorState, EditorAction } from './editorTypes.ts';
import { editorReducer, initialState } from './editorReducer.ts';

/** Selection-only slice — changes here do NOT trigger re-renders in document consumers. */
interface SelectionState {
  selectedIds: Set<string>;
  hoveredId: string | null;
}

const StateContext = createContext<EditorState>(initialState);
const SelectionContext = createContext<SelectionState>({ selectedIds: new Set(), hoveredId: null });
const DispatchContext = createContext<Dispatch<EditorAction>>(() => {});

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  // Stable selection reference — only changes when selectedIds/hoveredId actually change
  const selection = useMemo<SelectionState>(
    () => ({ selectedIds: state.selectedIds, hoveredId: state.hoveredId }),
    [state.selectedIds, state.hoveredId],
  );

  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>
        <SelectionContext.Provider value={selection}>
          {children}
        </SelectionContext.Provider>
      </StateContext.Provider>
    </DispatchContext.Provider>
  );
}

/** Full editor state — use only when you need document/project/tool state.
 *  NOTE: this re-renders on ANY state change including hover. Prefer useSelectionState()
 *  for components that only need highlight info. */
export function useEditorState() {
  return useContext(StateContext);
}

/** Selection-only state — only re-renders when selectedIds or hoveredId changes. */
export function useSelectionState() {
  return useContext(SelectionContext);
}

export function useEditorDispatch() {
  return useContext(DispatchContext);
}
