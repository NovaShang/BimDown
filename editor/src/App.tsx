import { useEffect } from 'react';
import { EditorProvider, useEditorDispatch } from './state/EditorContext.tsx';
import { loadProject, loadGrids, loadLayer } from './utils/loader.ts';
import { connectFileWatcher } from './utils/fileWatcher.ts';
import EditorShell from './components/EditorShell.tsx';

const model = new URLSearchParams(window.location.search).get('model') || 'Architecture';

function AppInner() {
  const dispatch = useEditorDispatch();

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      const [project, grids] = await Promise.all([loadProject(model), loadGrids(model)]);
      if (active) {
        dispatch({ type: 'SET_PROJECT', model, project, grids });
      }
    };

    loadData();

    const disconnect = connectFileWatcher(async (path) => {
      const parts = path.split('/');
      // File watcher paths are relative to sample_data/: {model}/{levelId}/{fileName}
      if (parts.length < 3 || parts[0] !== model) {
        // Not our model — ignore
        return;
      }

      const levelId = parts[1];
      const fileName = parts[2];
      console.log('Model data changed:', model, levelId, fileName);

      if (levelId === 'global' && fileName === 'level.csv') {
        loadData();
        return;
      }
      if (levelId === 'global' && fileName === 'grid.csv') {
        const grids = await loadGrids(model);
        if (active) dispatch({ type: 'UPDATE_GRIDS', grids });
        return;
      }

      let tableName = '';
      if (fileName.endsWith('.csv')) tableName = fileName.slice(0, -4);
      else if (fileName.endsWith('s.svg')) tableName = fileName.slice(0, -5);

      if (tableName) {
        const layer = await loadLayer(model, levelId, tableName);
        if (layer && active) {
          dispatch({ type: 'UPDATE_LAYER', levelId, layer });
        }
        return;
      }

      loadData();
    });

    return () => {
      active = false;
      disconnect();
    };
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
