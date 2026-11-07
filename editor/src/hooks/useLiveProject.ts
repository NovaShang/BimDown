import { useEffect, useRef } from 'react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { useDataSource } from '../utils/DataSourceContext.tsx';
import { loadProject, loadGrids, loadLayer, loadMepSystems, loadTypeCatalog, loadSections } from '../utils/loader.ts';
import { TYPE_FILE_PATHS } from '../model/types/catalog.ts';
import { VIEW_CSV_PATH } from '../views/sectionsIO.ts';
import { parseLayer } from '../model/parse.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import type { LineElement } from '../model/elements.ts';

const isWall = (tableName: string) =>
  tableName === 'wall' || tableName === 'structure_wall' || tableName === 'curtain_wall';

/** `level/table.csv` or `level/table.geojson` → table name ('' for anything else). */
export function changedTableName(fileName: string): string {
  if (fileName.endsWith('.csv')) return fileName.slice(0, -4);
  if (fileName.endsWith('.geojson')) return fileName.slice(0, -8);
  return '';
}

/**
 * Load the project from the current DataSource and keep it in sync with
 * external writes reported by `ds.watchChanges` (an AI agent or a text editor
 * changing files on disk): grids, MEP systems and single layers update in
 * place; level changes reload the whole project.
 *
 * Must be used inside both DataSourceProvider and EditorProvider.
 */
export function useLiveProject(model: string): void {
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const ds = useDataSource();

  // Read the current document without re-subscribing on every state change
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      const [project, grids] = await Promise.all([loadProject(ds), loadGrids(ds)]);
      if (active) dispatch({ type: 'SET_PROJECT', model, project, grids });
    };

    loadData();

    const disconnect = ds.watchChanges(async (path) => {
      // Ignore non-project files (e.g. .DS_Store)
      if (!path.endsWith('.csv') && !path.endsWith('.geojson') && !path.endsWith('.json')) return;

      const parts = path.split('/');
      if (parts.length < 2) { loadData(); return; }

      const levelId = parts[0]!;
      const fileName = parts.slice(1).join('/');

      if (levelId === 'global' && fileName === 'level.csv') { loadData(); return; }
      if (levelId === 'global' && fileName === 'grid.csv') {
        const grids = await loadGrids(ds);
        if (active) dispatch({ type: 'UPDATE_GRIDS', grids });
        return;
      }
      if (path === VIEW_CSV_PATH) {
        const sections = await loadSections(ds);
        if (active) dispatch({ type: 'UPDATE_SECTIONS', sections });
        return;
      }
      if (levelId === 'global' && fileName === 'mep_system.csv') {
        const mepSystems = await loadMepSystems(ds);
        if (active) dispatch({ type: 'UPDATE_MEP_SYSTEMS', mepSystems });
        return;
      }

      if (TYPE_FILE_PATHS.includes(path)) {
        const types = await loadTypeCatalog(ds);
        if (active) dispatch({ type: 'SET_TYPES', types });
        return;
      }

      const tableName = changedTableName(fileName);
      if (!tableName) return;
      const layer = await loadLayer(ds, levelId, tableName, undefined, stateRef.current.project?.types);
      if (!layer || !active) return;
      dispatch({ type: 'UPDATE_LAYER', levelId, layer });

      // Merge into the open document for immediate rendering (same level only)
      const doc = stateRef.current.document;
      if (!doc || doc.levelId !== levelId) return;
      const parsed = parseLayer(layer);
      // Resolve hosted elements (doors/windows) against current + incoming walls
      const wallMap = new Map<string, LineElement>();
      for (const el of doc.elements.values()) {
        if (el.geometry === 'line' && isWall(el.tableName)) wallMap.set(el.id, el as LineElement);
      }
      for (const el of parsed) {
        if (el.geometry === 'line' && isWall(el.tableName)) wallMap.set(el.id, el as LineElement);
      }
      for (const el of parsed) {
        if (el.geometry !== 'line') continue;
        const line = el as LineElement;
        if (!line.hostId) continue;
        const hostWall = wallMap.get(line.hostId);
        if (!hostWall) continue;
        const position = line.locationParam ?? 0.5;
        const width = parseFloat(line.attrs.width ?? '0.9');
        const resolved = resolveHostedGeometry(hostWall, position, width);
        line.start = resolved.start;
        line.end = resolved.end;
      }
      dispatch({ type: 'EXTERNAL_LAYER_UPDATE', levelId, elements: parsed });
    });

    return () => {
      active = false;
      disconnect();
    };
  }, [dispatch, ds, model]);
}
