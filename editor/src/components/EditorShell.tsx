import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getProcessedLayers, getProcessedLayersFromDocument, getComputedViewBox, getLayerGroups, getSelectedElementData } from '../state/selectors.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import { persistDocument, persistLevels, persistGrids, persistGlobalLayer, persistTypes, stampSpatialZMarker, removeLevelFiles, restoreLevelFiles } from '../utils/persist.ts';
import { groupByLayer, serializeToGeoJson } from '../model/serialize.ts';
import { gridsToElements, elementsToGrids } from '../utils/gridBridge.ts';
import { useDataSource } from '../utils/DataSourceContext.tsx';
import LeftPanel from './LeftPanel.tsx';
import Canvas from './Canvas.tsx';
import type { CanvasHandle } from './Canvas.tsx';
import FloatingToolbar from './FloatingToolbar.tsx';
import ViewToolbar from './ViewToolbar.tsx';
import SnapSettingsPanel, { isSnapInteraction } from './SnapSettingsPanel.tsx';
import TopBar from './TopBar.tsx';
import DrawingPropertiesBar from './DrawingPropertiesBar.tsx';
import RightPanel from './RightPanel.tsx';
import DrawingHints from './DrawingHints.tsx';
import SelectionActions from './SelectionActions.tsx';
import OnboardingTour from './OnboardingTour.tsx';
import { useOverlayItems } from '../hooks/useOverlayItems.ts';
import { useMediaQuery } from '../hooks/useMediaQuery.ts';


const Canvas3D = lazy(() => import('../three/Canvas3D.tsx'));

export default function EditorShell({ paddingRight = 0 }: { paddingRight?: number }) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const ds = useDataSource();

  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mobilePanel, setMobilePanel] = useState<'left' | 'right' | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const dsRef = useRef(ds);
  dsRef.current = ds;

  // Write the document's changed layers. Spatial Z goes back to absolute using
  // the level elevation; the first save of a project that is safe to mark
  // also stamps `spatial_z: "absolute"` (see ProjectData.spatialZMarkable).
  const spatialZStamped = useRef(false);
  const persistDoc = useRef(async (doc: NonNullable<typeof state.document>, changedKeys: Set<string>) => {
    const project = stateRef.current.project;
    const elevation = project?.levels.find(l => l.id === doc.levelId)?.elevation ?? 0;
    await persistDocument(doc, dsRef.current, changedKeys, elevation, project?.types);
    if (project?.spatialZMarkable && !spatialZStamped.current) {
      spatialZStamped.current = true;
      await stampSpatialZMarker(dsRef.current);
    }
  });

  // Auto-persist: write to disk on every document mutation
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingKeys = useRef(new Set<string>());
  const lastProcessedVersion = useRef(0);

  // Flush pending saves immediately, returns a promise that resolves when persist completes.
  const flushPendingSave = useRef(async () => {
    clearTimeout(persistTimer.current);
    const currentState = stateRef.current;
    // No document: its level was just removed, nothing of it may be written.
    if (!currentState.document) pendingKeys.current.clear();
    if (!currentState.document || pendingKeys.current.size === 0) return;
    const changedKeys = new Set(pendingKeys.current);
    pendingKeys.current.clear();
    try {
      await persistDoc.current(currentState.document, changedKeys);
      // If grids changed, persist to global/grid.csv and sync state
      if (changedKeys.has('reference/grid')) {
        const gridEls = Array.from(currentState.document.elements.values()).filter(e => e.tableName === 'grid');
        const grids = elementsToGrids(gridEls);
        await persistGrids(grids, dsRef.current);
        // Sync grids back to state for cross-level consistency
        dispatch({ type: 'UPDATE_GRIDS', grids });
      }
      // Persist migrated global layers
      for (const key of changedKeys) {
        if (!key.startsWith('__global__/')) continue;
        const tableName = key.slice('__global__/'.length);
        const gl = currentState.project?.globalLayers.find(l => l.tableName === tableName);
        if (gl) await persistGlobalLayer(gl, dsRef.current, currentState.project?.types);
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
      const geojsonContent = serializeToGeoJson(groupElements);
      const csvRows = new Map<string, Record<string, string>>();
      for (const el of groupElements) {
        csvRows.set(el.id, el.attrs);
      }
      dispatch({ type: 'UPDATE_LAYER', levelId: doc.levelId, layer: { tableName, discipline, geojsonContent, csvRows } });
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
    // The new document counts versions from 0 again: forget the old level's
    // last version, or its first edits here would be skipped and never saved.
    lastProcessedVersion.current = 0;
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

      persistDoc.current(doc, changedKeys)
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

  // Persist levels when they change (add, remove, rename). A removed level's
  // folder is deleted (contents kept here so undo can write them back).
  const prevLevelsRef = useRef(state.project?.levels);
  const removedLevelFiles = useRef(new Map<string, Record<string, string>>());
  const levelFileOps = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const levels = state.project?.levels;
    const prev = prevLevelsRef.current;
    if (!levels || levels === prev) return;
    prevLevelsRef.current = levels;
    if (!prev) return;
    persistLevels(levels, ds).catch(err => console.error('Persist levels failed:', err));
    const now = new Set(levels.map(l => l.id));
    const was = new Set(prev.map(l => l.id));
    for (const { id } of prev) {
      if (now.has(id)) continue;
      levelFileOps.current = levelFileOps.current
        .then(() => removeLevelFiles(ds, id))
        .then(files => { removedLevelFiles.current.set(id, files); })
        .catch(err => console.error('Remove level files failed:', err));
    }
    for (const { id } of levels) {
      if (was.has(id)) continue;
      levelFileOps.current = levelFileOps.current
        .then(async () => {
          const files = removedLevelFiles.current.get(id);
          removedLevelFiles.current.delete(id);
          if (files) await restoreLevelFiles(ds, files);
        })
        .catch(err => console.error('Restore level files failed:', err));
    }
  }, [state.project?.levels, ds]);

  // Persist element types (global/*_type.csv + type_layer.csv) when the
  // catalog changes — type edits, undo/redo of them, first use of a starter
  // type. Neither an unsaved starter catalog nor one just read from disk is written.
  const prevTypesRef = useRef(state.project?.types);
  useEffect(() => {
    const types = state.project?.types;
    if (types === prevTypesRef.current) return;
    const hadTypes = prevTypesRef.current !== undefined;
    prevTypesRef.current = types;
    if (!types || !hadTypes || !types.saved || types.fromDisk || state.readonly) return;
    persistTypes(types, ds).catch(err => console.error('Persist types failed:', err));
  }, [state.project?.types, state.readonly, ds]);

  // Use document model for rendering when available
  const processedLayers = useMemo(
    () => state.document ? getProcessedLayersFromDocument(state) : getProcessedLayers(state),
    [state.document, state.documentVersion, state.project, state.currentLevel, state.visibleLayers, state.activeDiscipline, state.showArchContext, state.viewOptions.showStructureInArch],
  );
  // viewBox only recomputes on level change / project load — not on every edit.
  // This keeps the canvas coordinate space stable during drawing; SVG overflow:visible
  // ensures elements beyond the viewBox are still rendered.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewBox = useMemo(() => getComputedViewBox(state), [state.project, state.currentLevel]);
  const layerGroups = useMemo(
    () => getLayerGroups(state),
    // documentVersion bumps on every CREATE / DELETE / UPDATE_ATTRS / MOVE /
    // RESIZE — needed so the panel's counts + element list track live edits
    // instead of waiting for a project reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.project, state.currentLevel, state.visibleLayers, state.activeDiscipline, state.document, state.documentVersion],
  );
  const selectedData = useMemo(() => getSelectedElementData(state), [state.selectedIds, state.project, state.currentLevel, state.document, state.documentVersion]);
  const activeDiscipline = state.activeDiscipline;

  // Overlay items for selection action bar
  const showSelectionActions = state.selectedIds.size > 0 && !state.readonly && !state.activeTool.startsWith('relocate') && state.activeTool !== 'rotate';
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
        {/* Mobile panel toggle buttons */}
        {isMobile && (
          <div className="absolute left-3 top-16 z-40 flex flex-col gap-1">
            <button
              className="glass-panel flex size-9 items-center justify-center rounded-lg border border-[var(--panel-border)] text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
              onClick={() => setMobilePanel(p => p === 'left' ? null : 'left')}
              title="Floors & Layers"
            >
              ☰
            </button>
            {state.selectedIds.size > 0 && (
              <button
                className="glass-panel flex size-9 items-center justify-center rounded-lg border border-[var(--panel-border)] text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
                onClick={() => setMobilePanel(p => p === 'right' ? null : 'right')}
                title="Properties"
              >
                ⓘ
              </button>
            )}
          </div>
        )}

        {/* Mobile overlay backdrop */}
        {isMobile && mobilePanel && (
          <div className="absolute inset-0 z-30 bg-black/30" onClick={() => setMobilePanel(null)} />
        )}

        {(!isMobile || mobilePanel === 'left') && (
          <LeftPanel
            levels={state.project?.levels ?? []}
            currentLevel={state.currentLevel}
            layerGroups={layerGroups}
            visibleLayers={state.visibleLayers}
          />
        )}
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
        {/* Hide the top discipline bar while the snap panel occupies the same slot. */}
        {!(!state.readonly && isSnapInteraction(state.activeTool, state.drawingState)) && <TopBar />}
        {!state.readonly && <DrawingPropertiesBar />}
        {!state.readonly && <FloatingToolbar activeDiscipline={activeDiscipline} />}
        <ViewToolbar
          onZoomToFit={handleZoomToFit}
          scale={state.viewMode === '2d' ? canvasScale : undefined}
        />
        {!state.readonly && <SnapSettingsPanel />}
        {(!isMobile || mobilePanel === 'right') && (
          <RightPanel
            selectedData={selectedData}
            levels={state.project?.levels ?? []}
            offsetRight={paddingRight}
            readonly={state.readonly}
          />
        )}
        <DrawingHints />
        {/* The tour teaches editing tools: not for read-only / shared views */}
        {!state.readonly && <OnboardingTour />}
      </div>
    </div>
  );
}
