import type { Level } from '../types.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { useEditorDispatch } from '../state/EditorContext.tsx';
import type { LayerGroup } from '../state/editorTypes.ts';

interface LeftPanelProps {
  levels: Level[];
  currentLevel: string;
  layerGroups: LayerGroup[];
  visibleLayers: Set<string>;
  showGrid: boolean;
  expandedDisciplines: Set<string>;
}

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
  showGrid,
  expandedDisciplines,
}: LeftPanelProps) {
  const dispatch = useEditorDispatch();

  return (
    <div className="left-panel">
      {/* Floor Switcher */}
      <div className="panel-section floor-section">
        <div className="section-header">Floors</div>
        <div className="floor-list">
          {levels.map(level => (
            <button
              key={level.id}
              className={`floor-btn ${currentLevel === level.id ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_LEVEL', levelId: level.id })}
              title={`${level.name} (${level.elevation}m)`}
            >
              <span className="floor-name">{level.name || level.id}</span>
              <span className="floor-elev">{level.elevation.toFixed(1)}m</span>
            </button>
          ))}
        </div>
      </div>

      {/* Layers */}
      <div className="panel-section layer-section">
        <div className="section-header">Layers</div>

        {/* Grid toggle */}
        <button
          className={`layer-item ${showGrid ? '' : 'off'}`}
          onClick={() => dispatch({ type: 'TOGGLE_GRID' })}
        >
          <span className="layer-dot" style={{ background: '#ef476f' }} />
          <span className="layer-icon">┼</span>
          <span className="layer-label">Grids</span>
          <span className={`layer-eye ${showGrid ? 'visible' : 'hidden'}`}>
            {showGrid ? '◉' : '○'}
          </span>
        </button>

        {/* Discipline groups */}
        {layerGroups.map(group => {
          const expanded = expandedDisciplines.has(group.discipline);
          const color = DISCIPLINE_COLORS[group.discipline] || '#888';
          const sortedLayers = [...group.layers].sort((a, b) => {
            const oa = LAYER_STYLES[a.tableName]?.order ?? 99;
            const ob = LAYER_STYLES[b.tableName]?.order ?? 99;
            return oa - ob;
          });

          return (
            <div key={group.discipline} className="discipline-group">
              <button
                className="discipline-header"
                onClick={() => dispatch({ type: 'TOGGLE_DISCIPLINE_EXPAND', discipline: group.discipline })}
              >
                <span className="expand-arrow">{expanded ? '▾' : '▸'}</span>
                <span className="discipline-dot" style={{ background: color }} />
                <span className="discipline-name">
                  {group.discipline.charAt(0).toUpperCase() + group.discipline.slice(1)}
                </span>
                <span className="discipline-count">{group.layers.length}</span>
              </button>

              {expanded && sortedLayers.map(layer => {
                const key = `${layer.discipline}/${layer.tableName}`;
                const style = LAYER_STYLES[layer.tableName];
                const isVisible = visibleLayers.has(key);
                return (
                  <button
                    key={key}
                    className={`layer-item ${isVisible ? '' : 'off'}`}
                    onClick={() => dispatch({ type: 'TOGGLE_LAYER', key })}
                  >
                    <span className="layer-dot" style={{ background: style?.color || '#888' }} />
                    <span className="layer-icon">{style?.icon || '◻'}</span>
                    <span className="layer-label">{style?.displayName || layer.tableName}</span>
                    <span className="layer-count">{layer.csvRows.size}</span>
                    <span className={`layer-eye ${isVisible ? 'visible' : 'hidden'}`}>
                      {isVisible ? '◉' : '○'}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
