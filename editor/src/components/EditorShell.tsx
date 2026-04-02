import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getProcessedLayers, getProcessedLayersFromDocument, getComputedViewBox, getLayerGroups, getSelectedElementData } from '../state/selectors.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import { persistDocument, persistLevels, persistGrids } from '../utils/persist.ts';
import { groupByLayer, serializeToSvg } from '../model/serialize.ts';
import { gridsToElements, elementsToGrids } from '../utils/gridBridge.ts';
import { useDataSource } from '../utils/DataSourceContext.tsx';
import LeftPanel from './LeftPanel.tsx';
import Canvas from './Canvas.tsx';
import type { CanvasHandle } from './Canvas.tsx';
import FloatingToolbar from './FloatingToolbar.tsx';
import ViewToolbar from './ViewToolbar.tsx';
import TopBar from './TopBar.tsx';
import DrawingPropertiesBar from './DrawingPropertiesBar.tsx';
import SelectionActions from './SelectionActions.tsx';
import { useOverlayItems } from '../hooks/useOverlayItems.ts';


const Canvas3D = lazy(() => import('../three/Canvas3D.tsx'));

export default function EditorShell() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const ds = useDataSource();

  const stateRef = useRef(state);
  stateRef.current = state;
  const dsRef = useRef(ds);
  dsRef.current = ds;

  // Auto-persist: write to disk on every document mutation
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingKeys = useRef(new Set<string>());
  const lastProcessedVersion = useRef(0);

  // Flush pending saves immediately, returns a promise that resolves when persist completes.
  const flushPendingSave = useRef(async () => {
    clearTimeout(persistTimer.current);
    const currentState = stateRef.current;
    if (!currentState.document || pendingKeys.current.size === 0) return;
    const changedKeys = new Set(pendingKeys.current);
    pendingKeys.current.clear();
    lastProcessedVersion.current = 0;
    try {
      await persistDocument(currentState.document, dsRef.current, changedKeys);
      // If grids changed, persist to global/grid.csv and sync state
      if (changedKeys.has('reference/grid')) {
        const gridEls = Array.from(currentState.document.elements.values()).filter(e => e.tableName === 'grid');
        const grids = elementsToGrids(gridEls);
        await persistGrids(grids, dsRef.current);
        // Sync grids back to state for cross-level consistency
        dispatch({ type: 'UPDATE_GRIDS', grids });
      }
    } catch (err) {
      console.error('Flush persist failed:', err);
    }
  });

  // Sync current document's in-memory edits back to project.floors before switching levels.
  // This ensures switching away and back doesn't lose unsaved edits.
  const syncDocumentToProject = useRef(() => {
    const s = stateRef.current;
    if (!s.document || s.documentVersion === 0 || !s.project) return;
    const doc = s.document;
    const elements = Array.from(doc.elements.values()).filter(e => e.tableName !== 'grid');
    const groups = groupByLayer(elements);

    for (const [key, groupElements] of groups) {
      const [discipline, tableName] = key.split('/');
      const svgContent = serializeToSvg(groupElements);
      const csvRows = new Map<string, Record<string, string>>();
      for (const el of groupElements) {
        csvRows.set(el.id, el.attrs);
      }
      dispatch({ type: 'UPDATE_LAYER', levelId: doc.levelId, layer: { tableName, discipline, svgContent, csvRows } });
    }

    // Sync grid changes back to state.grids
    const gridEls = Array.from(doc.elements.values()).filter(e => e.tableName === 'grid');
    if (gridEls.length > 0 || s.grids.length > 0) {
      dispatch({ type: 'UPDATE_GRIDS', grids: elementsToGrids(gridEls) });
    }
  });

  // Sync document to project when switching to 3D (so 3D sees latest edits)
  const prevViewModeRef = useRef(state.viewMode);
  useEffect(() => {
    if (state.viewMode === '3d' && prevViewModeRef.current === '2d') {
      syncDocumentToProject.current();
    }
    prevViewModeRef.current = state.viewMode;
  }, [state.viewMode]);

  // Initialize document model when level changes or project first loads.
  // We must NOT re-init when state.project changes due to UPDATE_LAYER from
  // our own auto-persist cycle, as that would wipe undo history.
  const prevLevelRef = useRef('');
  const projectLoadedRef = useRef(false);
  useEffect(() => {
    const isLevelChange = state.currentLevel !== prevLevelRef.current;
    const isInitialLoad = !projectLoadedRef.current && state.project;

    if (isLevelChange) {
      // Sync previous document back to project before switching
      syncDocumentToProject.current();
      flushPendingSave.current();
      prevLevelRef.current = state.currentLevel;
    }

    // Only re-initialize document on level change or first project load.
    // Ignore state.project reference changes from UPDATE_LAYER.
    if (!isLevelChange && !isInitialLoad) return;
    if (isInitialLoad) projectLoadedRef.current = true;

    if (!state.currentLevel) return;
    const floor = state.project?.floors.get(state.currentLevel);
    const elements = floor ? parseFloorLayers(floor.layers) : [];
    // Inject grid elements from global state
    const gridElements = gridsToElements(state.grids);
    const doc = createDocument(state.currentLevel, [...elements, ...gridElements]);
    dispatch({ type: 'INIT_DOCUMENT', document: doc });
  }, [state.project, state.currentLevel, dispatch]);

  useEffect(() => {
    if (!state.document || state.documentVersion === 0 || state.readonly) return;

    // Accumulate pending keys from O(1) mutations
    if (state.lastMutation && state.lastMutation.version > lastProcessedVersion.current) {
      for (const key of state.lastMutation.keys) pendingKeys.current.add(key);
      lastProcessedVersion.current = state.lastMutation.version;
    }

    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const currentState = stateRef.current;
      const doc = currentState.document!;

      if (pendingKeys.current.size === 0) return; // nothing to save

      const changedKeys = new Set(pendingKeys.current);
      pendingKeys.current.clear();

      persistDocument(doc, dsRef.current, changedKeys)
        .then(async () => {
          // If grids changed, also persist to global/grid.csv
          if (changedKeys.has('reference/grid')) {
            const gridEls = Array.from(currentState.document!.elements.values()).filter(e => e.tableName === 'grid');
            const grids = elementsToGrids(gridEls);
            await persistGrids(grids, dsRef.current);
            dispatch({ type: 'UPDATE_GRIDS', grids });
          }
        })
        .catch(err => console.error('Auto-persist failed:', err));
    }, 100);
    return () => clearTimeout(persistTimer.current);
  }, [state.documentVersion, state.lastMutation]);

  // Persist levels when they change (add, remove, rename)
  const prevLevelsRef = useRef(state.project?.levels);
  useEffect(() => {
    const levels = state.project?.levels;
    if (!levels || levels === prevLevelsRef.current) return;
    if (prevLevelsRef.current) {
      persistLevels(levels, ds).catch(err => console.error('Persist levels failed:', err));
    }
    prevLevelsRef.current = levels;
  }, [state.project?.levels, ds]);

  // Use document model for rendering when available
  const processedLayers = useMemo(
    () => state.document ? getProcessedLayersFromDocument(state) : getProcessedLayers(state),
    [state.document, state.documentVersion, state.project, state.currentLevel, state.visibleLayers, state.activeDiscipline],
  );
  // viewBox only recomputes on level change / project load — not on every edit.
  // This keeps the canvas coordinate space stable during drawing; SVG overflow:visible
  // ensures elements beyond the viewBox are still rendered.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewBox = useMemo(() => getComputedViewBox(state), [state.project, state.currentLevel]);
  const layerGroups = useMemo(() => getLayerGroups(state), [state.project, state.currentLevel, state.visibleLayers, state.activeDiscipline]);
  const selectedData = useMemo(() => getSelectedElementData(state), [state.selectedIds, state.project, state.currentLevel, state.document, state.documentVersion]);
  const activeDiscipline = state.activeDiscipline;

  // Overlay items for selection action bar
  const showSelectionActions = state.selectedIds.size > 0 && !state.readonly && state.activeTool !== 'relocate';
  const selectionContent = showSelectionActions ? <SelectionActions /> : null;
  const overlayItems = useOverlayItems(state.selectedIds, state.document, selectionContent);

  // Current level elevation for 3D overlay projection
  const currentElevation = useMemo(() => {
    if (!state.project) return 0;
    for (const l of state.project.levels) {
      if (l.id === state.currentLevel) return l.elevation;
    }
    return 0;
  }, [state.project, state.currentLevel]);

  // Canvas ref for view toolbar integration
  const canvasRef = useRef<CanvasHandle>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const handleZoomToFit2D = useCallback(() => canvasRef.current?.zoomToFit(), []);
  const handleZoomToFit3D = useCallback(() => window.dispatchEvent(new Event('zoom-to-fit-3d')), []);
  const handleZoomToFit = state.viewMode === '3d' ? handleZoomToFit3D : handleZoomToFit2D;

  // Poll scale from canvas (updates on re-render triggered by state changes)
  useEffect(() => {
    const id = setInterval(() => {
      const s = canvasRef.current?.getScale();
      if (s != null) setCanvasScale(s);
    }, 200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="relative h-full w-full">
      <div className="relative h-full overflow-hidden">
        <LeftPanel
          levels={state.project?.levels ?? []}
          currentLevel={state.currentLevel}
          layerGroups={layerGroups}
          visibleLayers={state.visibleLayers}
          selectedData={selectedData}
        />
        {state.viewMode === '3d' ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="text-center"><div className="mx-auto mb-3 size-8 animate-spin rounded-full border-2 border-border border-t-[var(--color-accent)]" /><p className="text-xs text-muted-foreground">Loading 3D viewer...</p></div></div>}>
            <Canvas3D overlayItems={overlayItems} elevation={currentElevation} />
          </Suspense>
        ) : (
          <Canvas
            ref={canvasRef}
            layers={processedLayers}
            viewBox={viewBox}
            activeFilter={state.activeFilter}
            activeDiscipline={activeDiscipline}
            overlayItems={overlayItems}
          />
        )}
        <TopBar />
        {!state.readonly && <DrawingPropertiesBar />}
        {!state.readonly && <FloatingToolbar activeDiscipline={activeDiscipline} />}
        <ViewToolbar
          onZoomToFit={handleZoomToFit}
          scale={state.viewMode === '2d' ? canvasScale : undefined}
        />
      </div>
    </div>
  );
}
