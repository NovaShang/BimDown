import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { LAYER_STYLES, DISCIPLINE_TABLES, DISCIPLINE_COLORS } from '../types.ts';
import { geometryTypeForTable } from '../model/elements.ts';
import type { Tool } from '../state/editorTypes.ts';

interface FloatingToolbarProps {
  activeDiscipline: string | null;
}

import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

const TOOLS: { tool: Tool; label: string; icon: IconName; shortcut: string }[] = [
  { tool: 'select', label: 'Select', icon: 'select', shortcut: 'V' },
  { tool: 'pan', label: 'Pan', icon: 'pan', shortcut: 'H' },
  { tool: 'zoom', label: 'Zoom', icon: 'zoom', shortcut: 'Z' },
];

function getDrawTool(tableName: string): Tool {
  const geom = geometryTypeForTable(tableName);
  switch (geom) {
    case 'line': return 'draw_line';
    case 'point': return 'draw_point';
    case 'polygon': return 'draw_polygon';
    default: return 'draw_line';
  }
}

export default function FloatingToolbar({ activeDiscipline }: FloatingToolbarProps) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const disciplineTables = activeDiscipline ? (DISCIPLINE_TABLES[activeDiscipline] || []) : [];
  const disciplineColor = activeDiscipline ? (DISCIPLINE_COLORS[activeDiscipline] || '#888') : '#888';

  const handleDrawToolClick = (tableName: string, discipline: string) => {
    const currentTarget = state.drawingTarget;
    // Toggle off if clicking the same tool
    if (currentTarget?.tableName === tableName && currentTarget?.discipline === discipline) {
      dispatch({ type: 'SET_TOOL', tool: 'select' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      return;
    }

    const drawTool = getDrawTool(tableName);
    dispatch({ type: 'SET_TOOL', tool: drawTool });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName, discipline } });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  };

  const canUndo = state.history.undoStack.length > 0;
  const canRedo = state.history.redoStack.length > 0;

  return (
    <div className="floating-toolbar">
      {/* General tools */}
      <div className="toolbar-group">
        {TOOLS.map(t => (
          <button
            key={t.tool}
            className={`toolbar-btn ${state.activeTool === t.tool ? 'active' : ''}`}
            onClick={() => {
              dispatch({ type: 'SET_TOOL', tool: t.tool });
              dispatch({ type: 'SET_DRAWING_TARGET', target: null });
              dispatch({ type: 'SET_DRAWING_STATE', state: null });
            }}
            title={`${t.label} (${t.shortcut})`}
          >
            <span className="toolbar-icon">
              <Icon name={t.icon} />
            </span>
          </button>
        ))}
      </div>

      {/* Separator */}
      {disciplineTables.length > 0 && <div className="toolbar-separator" />}

      {/* Discipline drawing tools */}
      {disciplineTables.length > 0 && (
        <div className="toolbar-group">
          {disciplineTables.map(table => {
            const style = LAYER_STYLES[table];
            if (!style) return null;
            const isActive = state.drawingTarget?.tableName === table &&
              state.drawingTarget?.discipline === activeDiscipline;
            return (
              <button
                key={table}
                className={`toolbar-btn discipline-tool ${isActive ? 'active' : ''}`}
                onClick={() => handleDrawToolClick(table, activeDiscipline!)}
                title={`Draw ${style.displayName}`}
                style={{
                  '--tool-color': isActive ? disciplineColor : undefined,
                } as React.CSSProperties}
              >
                <span className="toolbar-icon">
                  <Icon name={table} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Separator */}
      <div className="toolbar-separator" />

      {/* Undo/Redo */}
      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${!canUndo ? 'disabled' : ''}`}
          onClick={() => canUndo && dispatch({ type: 'UNDO' })}
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
        >
          <span className="toolbar-icon"><Icon name="undo" /></span>
        </button>
        <button
          className={`toolbar-btn ${!canRedo ? 'disabled' : ''}`}
          onClick={() => canRedo && dispatch({ type: 'REDO' })}
          title="Redo (Ctrl+Y)"
          disabled={!canRedo}
        >
          <span className="toolbar-icon"><Icon name="redo" /></span>
        </button>
      </div>
    </div>
  );
}
