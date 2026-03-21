import type { Level } from '../types.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { LayerGroup } from '../state/editorTypes.ts';
import { Icon } from './Icons.tsx';

interface LeftPanelProps {
  levels: Level[];
  currentLevel: string;
  layerGroups: LayerGroup[];
  visibleLayers: Set<string>;
  showGrid: boolean;
}

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
  showGrid,
}: LeftPanelProps) {
  const dispatch = useEditorDispatch();
  const { activeDiscipline, viewMode: rawViewMode } = useEditorState();
  const viewMode = rawViewMode ?? '2d';

  const currentGroup = layerGroups.find(g => g.discipline === activeDiscipline);
  const currentGroupLayers = currentGroup ? [...currentGroup.layers].sort((a, b) => {
    const oa = LAYER_STYLES[a.tableName]?.order ?? 99;
    const ob = LAYER_STYLES[b.tableName]?.order ?? 99;
    return oa - ob;
  }) : [];

  return (
    <div className="left-panel">
      {/* 2D / 3D Toggle */}
      <div className="view-mode-toggle">
        <button
          className={`view-mode-btn ${viewMode === '2d' ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: '2d' })}
        >2D</button>
        <button
          className={`view-mode-btn ${viewMode === '3d' ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: '3d' })}
        >3D</button>
      </div>

      {/* Floor Switcher */}
      <div className="panel-section floor-section">
        <div className="section-header">Floors</div>
        <div className="floor-list">
          {viewMode === '3d' && (
            <button
              className={`floor-btn ${currentLevel === '__all__' ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_LEVEL', levelId: '__all__' })}
              title="All Floors"
            >
              <span className="floor-name">All Floors</span>
            </button>
          )}
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

      {/* Discipline Switcher */}
      <div className="panel-section floor-section">
        <div className="section-header">Disciplines</div>
        <div className="floor-list">
          {layerGroups.map(group => {
            const color = DISCIPLINE_COLORS[group.discipline] || '#888';
            return (
              <button
                key={group.discipline}
                className={`floor-btn ${activeDiscipline === group.discipline ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'SET_DISCIPLINE', discipline: group.discipline })}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="discipline-dot" style={{ background: color }} />
                  <span className="floor-name">
                    {group.discipline.charAt(0).toUpperCase() + group.discipline.slice(1)}
                  </span>
                </div>
                <span className="floor-elev" style={{ marginLeft: 0 }}>{group.layers.length} layers</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Layers */}
      <div className="panel-section layer-section">
        <div className="section-header">
          Layers {activeDiscipline ? `(${activeDiscipline.charAt(0).toUpperCase() + activeDiscipline.slice(1)})` : ''}
        </div>

        {/* Grid toggle */}
        <button
          className={`layer-item ${showGrid ? '' : 'off'}`}
          onClick={() => dispatch({ type: 'TOGGLE_GRID' })}
          style={{ marginBottom: '8px' }}
        >
          <span className="layer-dot" style={{ background: '#ef476f' }} />
          <span className="layer-icon"><Icon name="grid" width={16} height={16} /></span>
          <span className="layer-label">Grids</span>
          <span className={`layer-eye ${showGrid ? 'visible' : 'hidden'}`}>
            <Icon name={showGrid ? 'eye-visible' : 'eye-hidden'} width={18} height={18} />
          </span>
        </button>

        <div className="discipline-group">
          {currentGroupLayers.map(layer => {
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
                <span className="layer-icon"><Icon name={layer.tableName} width={16} height={16} /></span>
                <span className="layer-label">{style?.displayName || layer.tableName}</span>
                <span className="layer-count">{layer.csvRows.size}</span>
                <span className={`layer-eye ${isVisible ? 'visible' : 'hidden'}`}>
                  <Icon name={isVisible ? 'eye-visible' : 'eye-hidden'} width={18} height={18} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
