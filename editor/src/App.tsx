import { Component, useMemo } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { EditorProvider } from './state/EditorContext.tsx';
import { useLiveProject } from './hooks/useLiveProject.ts';
import { createLocalDataSource } from './utils/dataSource.ts';
import { DataSourceProvider } from './utils/DataSourceContext.tsx';
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
const readonly = params.get('readonly') === 'true';

function AppInner() {
  useLiveProject(projectId ?? model);
  return <EditorShell />;
}

export default function App() {
  const ds = useMemo(() => {
    return createLocalDataSource(model);
  }, []);

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <DataSourceProvider ds={ds}>
          <EditorProvider readonly={readonly}>
            <AppInner />
          </EditorProvider>
        </DataSourceProvider>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
