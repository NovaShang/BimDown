import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { LAYER_STYLES, DISCIPLINE_TABLES, DISCIPLINE_COLORS } from '../types.ts';
import type { Tool } from '../state/editorTypes.ts';

interface FloatingToolbarProps {
  activeDiscipline: string | null;
}

const TOOLS: { tool: Tool; label: string; icon: string; shortcut: string }[] = [
  { tool: 'select', label: 'Select', icon: '⬚', shortcut: 'V' },
  { tool: 'pan', label: 'Pan', icon: '✋', shortcut: 'H' },
  { tool: 'zoom', label: 'Zoom', icon: '🔍', shortcut: 'Z' },
];

export default function FloatingToolbar({ activeDiscipline }: FloatingToolbarProps) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const disciplineTables = activeDiscipline ? (DISCIPLINE_TABLES[activeDiscipline] || []) : [];
  const disciplineColor = activeDiscipline ? (DISCIPLINE_COLORS[activeDiscipline] || '#888') : '#888';

  return (
    <div className="floating-toolbar">
      {/* General tools */}
      <div className="toolbar-group">
        {TOOLS.map(t => (
          <button
            key={t.tool}
            className={`toolbar-btn ${state.activeTool === t.tool ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_TOOL', tool: t.tool })}
            title={`${t.label} (${t.shortcut})`}
          >
            <span className="toolbar-icon">{t.icon}</span>
          </button>
        ))}
      </div>

      {/* Separator */}
      {disciplineTables.length > 0 && <div className="toolbar-separator" />}

      {/* Discipline tools */}
      {disciplineTables.length > 0 && (
        <div className="toolbar-group">
          {disciplineTables.map(table => {
            const style = LAYER_STYLES[table];
            if (!style) return null;
            const isActive = state.activeFilter === table;
            return (
              <button
                key={table}
                className={`toolbar-btn discipline-tool ${isActive ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'SET_FILTER', filter: table })}
                title={style.displayName}
                style={{
                  '--tool-color': isActive ? disciplineColor : undefined,
                } as React.CSSProperties}
              >
                <span className="toolbar-icon">{style.icon}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
