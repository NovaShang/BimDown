import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { useDataSource } from '../utils/DataSourceContext.tsx';
import { getProjectUnits } from '../utils/units.ts';
import { setUnderlaySnapProvider } from '../utils/snap.ts';
import { onUnderlayCsvChanged, UnderlayStore, type UnderlaySnapshot } from './store.ts';

const StoreContext = createContext<UnderlayStore | null>(null);

/** The mounted editor's store, for tool handlers (module singletons). */
let activeStore: UnderlayStore | null = null;
export function getActiveUnderlayStore(): UnderlayStore | null {
  return activeStore;
}

/**
 * Owns the underlay store for the current DataSource and keeps it in step
 * with the editor: level, units, deleted levels, the 'underlay' tool, and
 * external writes to global/underlay.csv.
 */
export function UnderlayProvider({ children }: { children: ReactNode }) {
  const ds = useDataSource();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const store = useMemo(() => new UnderlayStore(ds, state.readonly), [ds, state.readonly]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    activeStore = store;
    setUnderlaySnapProvider(store.snapTargets);
    store.attach();
    void store.load();
    const off = onUnderlayCsvChanged(() => { void store.load(); });
    return () => {
      off();
      if (activeStore === store) {
        activeStore = null;
        setUnderlaySnapProvider(null);
      }
      store.detach();
    };
  }, [store]);

  useEffect(() => { store.setLevel(state.currentLevel); }, [store, state.currentLevel]);
  const unit = getProjectUnits(state);
  useEffect(() => { store.setUnit(unit); }, [store, unit]);

  // Underlays of a deleted level go with it.
  const levels = state.project?.levels;
  useEffect(() => {
    if (levels) store.pruneLevels(new Set(levels.map(l => l.id)));
  }, [store, levels]);

  // The 'underlay' tool runs while an interaction does: finishing one returns
  // to Select, leaving the tool (Escape, another tool) cancels it. Reacts to
  // transitions only — starting one sets the mode and the tool in two steps.
  const toolActive = state.activeTool === 'underlay';
  const prev = useRef({ mode: snap.mode, toolActive });
  useEffect(() => {
    const was = prev.current;
    prev.current = { mode: snap.mode, toolActive };
    if (was.mode && !snap.mode && toolActive) dispatch({ type: 'SET_TOOL', tool: 'select' });
    else if (was.toolActive && !toolActive && snap.mode) store.cancelMode();
  }, [toolActive, snap.mode, store, dispatch]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useUnderlayStore(): UnderlayStore | null {
  return useContext(StoreContext);
}

const EMPTY: UnderlaySnapshot = {
  underlays: [], assets: new Map(), selectedId: null, mode: null, cursor: null, calibration: null, importing: false,
};
const noop = () => () => {};

export function useUnderlaySnapshot(): UnderlaySnapshot {
  const store = useUnderlayStore();
  return useSyncExternalStore(store?.subscribe ?? noop, store ? store.getSnapshot : () => EMPTY);
}
