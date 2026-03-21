import { useEffect } from 'react';
import { EditorProvider, useEditorDispatch } from './state/EditorContext.tsx';
import { loadProject, loadGrids, loadLayer } from './utils/loader.ts';
import EditorShell from './components/EditorShell.tsx';

function AppInner() {
  const dispatch = useEditorDispatch();

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      const [project, grids] = await Promise.all([loadProject(), loadGrids()]);
      if (active) {
        dispatch({ type: 'SET_PROJECT', project, grids });
      }
    };

    loadData();

    // Auto-refresh via SSE
    const es = new EventSource('/api/watch');
    es.onmessage = async (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'change') {
          console.log('Sample data changed:', data.path);
          const parts = data.path.split('/');
          
          if (parts.length >= 3) {
            const discipline = parts[0];
            const levelId = parts[1];
            const fileName = parts[2];
            
            if (levelId === 'global' && fileName === 'level.csv') {
              loadData();
              return;
            }
            if (levelId === 'global' && fileName === 'grid.csv') {
              const grids = await loadGrids();
              if (active) dispatch({ type: 'UPDATE_GRIDS', grids });
              return;
            }
            
            let tableName = '';
            if (fileName.endsWith('.csv')) tableName = fileName.slice(0, -4);
            else if (fileName.endsWith('s.svg')) tableName = fileName.slice(0, -5);
            
            if (tableName) {
              const layer = await loadLayer(discipline, levelId, tableName);
              if (layer && active) {
                dispatch({ type: 'UPDATE_LAYER', levelId, layer });
              }
              return;
            }
          }
          
          loadData();
        }
      } catch (err) {
        console.error('Failed to parse watch event:', err);
      }
    };

    return () => {
      active = false;
      es.close();
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
