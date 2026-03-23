import { useEffect, useMemo } from 'react';
import { EditorProvider, useEditorDispatch } from './state/EditorContext.tsx';
import { loadProject, loadGrids, loadLayer } from './utils/loader.ts';
import { createLocalDataSource, createApiDataSource } from './utils/dataSource.ts';
import { DataSourceProvider, useDataSource } from './utils/DataSourceContext.tsx';
import { TooltipProvider } from './components/ui/tooltip';
import EditorShell from './components/EditorShell.tsx';

const params = new URLSearchParams(window.location.search);
const model = params.get('model') || 'Architecture';
const projectId = params.get('project');

function AppInner() {
  const dispatch = useEditorDispatch();
  const ds = useDataSource();

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      const [project, grids] = await Promise.all([loadProject(ds), loadGrids(ds)]);
      if (active) {
        dispatch({ type: 'SET_PROJECT', model: projectId ?? model, project, grids });
      }
    };

    loadData();

    const disconnect = ds.watchChanges(async (path) => {
      const parts = path.split('/');
      if (parts.length < 2) { loadData(); return; }

      const levelId = parts[0];
      const fileName = parts.slice(1).join('/');
      console.log('Data changed:', levelId, fileName);

      if (levelId === 'global' && fileName === 'level.csv') {
        loadData();
        return;
      }
      if (levelId === 'global' && fileName === 'grid.csv') {
        const grids = await loadGrids(ds);
        if (active) dispatch({ type: 'UPDATE_GRIDS', grids });
        return;
      }

      let tableName = '';
      if (fileName.endsWith('.csv')) tableName = fileName.slice(0, -4);
      else if (fileName.endsWith('s.svg')) tableName = fileName.slice(0, -5);

      if (tableName) {
        const layer = await loadLayer(ds, levelId, tableName);
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
  }, [dispatch, ds]);

  return <EditorShell />;
}

export default function App() {
  const ds = useMemo(() => {
    if (projectId) return createApiDataSource(projectId);
    return createLocalDataSource(model);
  }, []);

  return (
    <TooltipProvider>
      <DataSourceProvider ds={ds}>
        <EditorProvider>
          <AppInner />
        </EditorProvider>
      </DataSourceProvider>
    </TooltipProvider>
  );
}
