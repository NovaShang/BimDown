import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';
import type { EditorState, EditorAction } from './editorTypes.ts';
import { editorReducer, initialState } from './editorReducer.ts';

const StateContext = createContext<EditorState>(initialState);
const DispatchContext = createContext<Dispatch<EditorAction>>(() => {});

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useEditorState() {
  return useContext(StateContext);
}

export function useEditorDispatch() {
  return useContext(DispatchContext);
}
