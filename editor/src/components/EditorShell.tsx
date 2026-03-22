import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getProcessedLayers, getProcessedLayersFromDocument, getComputedViewBox, getLayerGroups, getLevelsWithData, getSelectedElementData } from '../state/selectors.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import { persistDocument } from '../utils/persist.ts';
import LeftPanel from './LeftPanel.tsx';
import Canvas from './Canvas.tsx';
import FloatingToolbar from './FloatingToolbar.tsx';
import DrawingPropertiesBar from './DrawingPropertiesBar.tsx';
import FloatingProperties from './FloatingProperties.tsx';

const Canvas3D = lazy(() => import('../three/Canvas3D.tsx'));

export default function EditorShell() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  // Initialize document model when floor data loads or level changes
  // Skip for __all__ — 3D all-floors mode parses directly, no document model
  useEffect(() => {
    if (state.currentLevel === '__all__') return;
    const floor = state.project?.floors.get(state.currentLevel);
    if (!floor) return;
    const elements = parseFloorLayers(floor.layers);
    const doc = createDocument(state.currentLevel, elements);
    dispatch({ type: 'INIT_DOCUMENT', document: doc });
  }, [state.project, state.currentLevel, dispatch]);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Auto-persist: write to disk on every document mutation
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingKeys = useRef(new Set<string>());
  const lastProcessedVersion = useRef(0);

  useEffect(() => {
    if (!state.document || state.documentVersion === 0) return;

    // Accumulate pending keys from O(1) mutations
    if (state.lastMutation && state.lastMutation.version > lastProcessedVersion.current) {
      for (const key of state.lastMutation.keys) pendingKeys.current.add(key);
      lastProcessedVersion.current = state.lastMutation.version;
    }

    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const currentState = stateRef.current;
      const viewBox = getComputedViewBox(currentState);
      const vbStr = viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : '0 0 100 100';
      
      const doc = currentState.document!;
      
      if (pendingKeys.current.size === 0) return; // nothing to save
      
      const changedKeys = new Set(pendingKeys.current);
      pendingKeys.current.clear();
      
      persistDocument(doc, vbStr, currentState.modelName, changedKeys).catch(err => console.error('Auto-persist failed:', err));
    }, 100);
    return () => clearTimeout(persistTimer.current);
  }, [state.documentVersion, state.lastMutation]);

  // Use document model for rendering when available
  const processedLayers = useMemo(
    () => state.document ? getProcessedLayersFromDocument(state) : getProcessedLayers(state),
    [state.document, state.documentVersion, state.project, state.currentLevel, state.visibleLayers, state.activeDiscipline],
  );
  const viewBox = useMemo(() => getComputedViewBox(state), [state.project, state.currentLevel]);
  const layerGroups = useMemo(() => getLayerGroups(state), [state.project, state.currentLevel]);
  const levelsWithData = useMemo(() => getLevelsWithData(state), [state.project]);
  const selectedData = useMemo(() => getSelectedElementData(state), [state.selectedIds, state.project, state.currentLevel, state.document, state.documentVersion]);
  const activeDiscipline = state.activeDiscipline;

  // Set base viewBox when it changes
  useEffect(() => {
    if (viewBox && !state.baseViewBox) {
      dispatch({ type: 'SET_BASE_VIEWBOX', viewBox });
    }
  }, [viewBox, state.baseViewBox, dispatch]);



  return (
    <div className="editor-shell">
      <LeftPanel
        levels={levelsWithData}
        currentLevel={state.currentLevel}
        layerGroups={layerGroups}
        visibleLayers={state.visibleLayers}
        showGrid={state.showGrid}
      />
      <div className="canvas-area">
        {state.viewMode === '3d' ? (
          <Suspense fallback={<div className="loading-screen"><div className="loader"><div className="loader-spinner" /><p>Loading 3D viewer...</p></div></div>}>
            <Canvas3D />
          </Suspense>
        ) : (
          <>
            <Canvas
              layers={processedLayers}
              viewBox={viewBox}
              grids={state.grids}
              showGrid={state.showGrid}
              activeFilter={state.activeFilter}
              activeDiscipline={activeDiscipline}
            />
            <DrawingPropertiesBar />
            <FloatingToolbar activeDiscipline={activeDiscipline} />
          </>
        )}
        {selectedData.size > 0 && (
          <FloatingProperties selectedData={selectedData} />
        )}
      </div>
    </div>
  );
}
