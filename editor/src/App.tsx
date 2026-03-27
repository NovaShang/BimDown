import { Component, useEffect, useMemo } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { EditorProvider, useEditorDispatch } from './state/EditorContext.tsx';
import { loadProject, loadGrids, loadLayer } from './utils/loader.ts';
import { createLocalDataSource, createApiDataSource } from './utils/dataSource.ts';
import { DataSourceProvider, useDataSource } from './utils/DataSourceContext.tsx';
import { TooltipProvider } from './components/ui/tooltip';
import EditorShell from './components/EditorShell.tsx';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Editor crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#1a1a1a', color: '#ccc', fontFamily: 'system-ui' }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>&#x26A0;</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 16, color: '#fff' }}>Something went wrong / 出了点问题</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, opacity: 0.7 }}>{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #444', background: '#2c2c2c', color: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              Try Again / 重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const params = new URLSearchParams(window.location.search);
const model = params.get('model') || 'merged';
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
    <ErrorBoundary>
      <TooltipProvider>
        <DataSourceProvider ds={ds}>
          <EditorProvider>
            <AppInner />
          </EditorProvider>
        </DataSourceProvider>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
