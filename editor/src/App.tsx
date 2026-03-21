import { useEffect } from 'react';
import { EditorProvider, useEditorDispatch } from './state/EditorContext.tsx';
import { loadProject, loadGrids } from './utils/loader.ts';
import EditorShell from './components/EditorShell.tsx';

function AppInner() {
  const dispatch = useEditorDispatch();

  useEffect(() => {
    (async () => {
      const [project, grids] = await Promise.all([loadProject(), loadGrids()]);
      dispatch({ type: 'SET_PROJECT', project, grids });
    })();
  }, [dispatch]);

  return <EditorShell />;
}

export default function App() {
  return (
    <EditorProvider>
      <AppInner />
    </EditorProvider>
  );
}
