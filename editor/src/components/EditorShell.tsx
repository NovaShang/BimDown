import { useEffect, useMemo } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getProcessedLayers, getComputedViewBox, getLayerGroups, getLevelsWithData, getSelectedElementData, getActiveDiscipline } from '../state/selectors.ts';
import LeftPanel from './LeftPanel.tsx';
import Canvas from './Canvas.tsx';
import FloatingToolbar from './FloatingToolbar.tsx';
import FloatingProperties from './FloatingProperties.tsx';

export default function EditorShell() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const processedLayers = useMemo(() => getProcessedLayers(state), [state.project, state.currentLevel, state.visibleLayers]);
  const viewBox = useMemo(() => getComputedViewBox(state), [state.project, state.currentLevel]);
  const layerGroups = useMemo(() => getLayerGroups(state), [state.project, state.currentLevel]);
  const levelsWithData = useMemo(() => getLevelsWithData(state), [state.project]);
  const selectedData = useMemo(() => getSelectedElementData(state), [state.selectedIds, state.project, state.currentLevel]);
  const activeDiscipline = useMemo(() => getActiveDiscipline(state), [state.activeDiscipline, state.selectedIds, state.visibleLayers, state.project, state.currentLevel]);

  // Set base viewBox when it changes
  useEffect(() => {
    if (viewBox && !state.baseViewBox) {
      dispatch({ type: 'SET_BASE_VIEWBOX', viewBox });
    }
  }, [viewBox, state.baseViewBox, dispatch]);

  // Build grid SVG
  const gridSvg = useMemo(() => {
    if (!state.showGrid || state.grids.length === 0) return undefined;

    return state.grids.map(g => {
      const dx = Math.abs(g.x2 - g.x1);
      const dy = Math.abs(g.y2 - g.y1);
      const isShort = Math.sqrt(dx * dx + dy * dy) < 1;
      if (isShort) return '';

      const ext = 200;
      const ldx = g.x2 - g.x1;
      const ldy = g.y2 - g.y1;
      const len = Math.sqrt(ldx * ldx + ldy * ldy);
      const ux = ldx / len, uy = ldy / len;

      const x1 = g.x1 - ux * ext;
      const y1 = -(g.y1 - uy * ext);
      const x2 = g.x2 + ux * ext;
      const y2 = -(g.y2 + uy * ext);

      const lx = g.x1;
      const ly = -g.y1;

      return `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
              stroke="#ef476f" stroke-width="0.02" stroke-dasharray="0.15,0.1" opacity="0.4" />
        <circle cx="${lx}" cy="${ly}" r="0.35" fill="none" stroke="#ef476f" stroke-width="0.02" opacity="0.5" />
        <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central"
              font-size="0.28" font-family="Inter, sans-serif" font-weight="600" fill="#ef476f" opacity="0.6">
          ${g.number}
        </text>
      `;
    }).join('');
  }, [state.showGrid, state.grids]);

  return (
    <div className="editor-shell">
      <LeftPanel
        levels={levelsWithData}
        currentLevel={state.currentLevel}
        layerGroups={layerGroups}
        visibleLayers={state.visibleLayers}
        showGrid={state.showGrid}
        expandedDisciplines={state.expandedDisciplines}
      />
      <div className="canvas-area">
        <Canvas
          layers={processedLayers}
          viewBox={viewBox}
          gridSvg={gridSvg}
          activeFilter={state.activeFilter}
        />
        <FloatingToolbar activeDiscipline={activeDiscipline} />
        {selectedData.size > 0 && (
          <FloatingProperties selectedData={selectedData} />
        )}
      </div>
    </div>
  );
}
