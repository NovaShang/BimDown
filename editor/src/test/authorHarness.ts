/**
 * Headless authoring harness: drives the real drawing tools through the real
 * reducer (no DOM), then saves with the real persist path. Used by tests that
 * check what the editor writes (spec columns here; `bimdown validate/build`
 * in the BimClaw monorepo).
 */
import '../elements/registerAll.ts';
import '../families/sections/index.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import type { EditorAction, EditorState } from '../state/editorTypes.ts';
import type { ToolContext, ToolHandler } from '../tools/types.ts';
import { getElementTool } from '../tools/archetypes/index.ts';
import { getElementModule } from '../elements/registry.ts';
import { createDocument } from '../model/document.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { persistDocument, persistGrids, persistLevels } from '../utils/persist.ts';
import { memoryDataSource } from './memoryDataSource.ts';
import type { Level } from '../types.ts';
import { resetRouteMemory } from '../mep/routeTool.ts';

/** Screen pixels per model meter in the fake viewport. */
const PX = 100;

export interface Harness {
  readonly state: EditorState;
  dispatch(action: EditorAction): void;
  /** Activate the placement tool for `table` (like clicking it in the toolbar). */
  pick(table: string, attrs?: Record<string, string>, variantId?: string): void;
  /** Click at model coordinates with the active placement tool. */
  click(x: number, y: number, button?: number, mods?: { shiftKey?: boolean }): void;
  /** Leave the placement tool (Esc). */
  done(): void;
}

export function createHarness(levels: Level[] = [{ id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 }]): Harness {
  resetRouteMemory();
  let state: EditorState = { ...initialState, disabledSnapTypes: new Set() };
  const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
  dispatch({
    type: 'SET_PROJECT', model: 'test', grids: [],
    project: { levels, floors: new Map(), globalLayers: [], mepSystems: [], metadata: { format_version: '3.0', units: 'm', spatial_z: 'absolute' } },
  });
  dispatch({ type: 'INIT_DOCUMENT', document: createDocument(levels[0].id, []) });

  const ctx: ToolContext = {
    dispatch: dispatch as ToolContext['dispatch'],
    svgRef: { current: null },
    containerRef: { current: null },
    getState: () => ({ ...state, transform: { x: 0, y: 0, scale: PX } }),
    screenToSvg: (cx, cy) => ({ x: cx / PX, y: cy / PX }),
    findElementId: () => null,
    setSnap: () => {},
  };
  let tool: ToolHandler | null = null;

  return {
    get state() { return state; },
    dispatch,
    pick(table, attrs, variantId) {
      const mod = getElementModule(table);
      if (!mod) throw new Error(`unknown table ${table}`);
      dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: table, discipline: mod.discipline, variantId } });
      if (attrs) dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...state.drawingAttrs, ...attrs } });
      dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
      tool = getElementTool(table, 'place');
    },
    click(x, y, button = 0, mods = {}) {
      if (!tool) throw new Error('no tool picked');
      const e = { clientX: x * PX, clientY: y * PX, button, shiftKey: !!mods.shiftKey, ctrlKey: false, metaKey: false, altKey: false,
        preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent;
      tool.onPointerMove?.(ctx, e);
      tool.onPointerDown?.(ctx, e);
      tool.onPointerUp?.(ctx, e);
    },
    done() {
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      tool = null;
    },
  };
}

/** Save the harness document the way EditorShell does; returns the file map. */
export async function saveHarness(h: Harness): Promise<Record<string, string>> {
  const ds = memoryDataSource({
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }, null, 2) + '\n',
  });
  const s = h.state;
  const level = s.project!.levels.find(l => l.id === s.document!.levelId)!;
  await persistLevels(s.project!.levels, ds);
  await persistGrids([], ds);
  await persistDocument(s.document!, ds, undefined, level.elevation);
  // persistDocument writes empty strings for layers that became empty
  for (const [k, v] of Object.entries(ds.files)) if (v === '') delete ds.files[k];
  return ds.files;
}

/** Save every level (the open one from its document, the others from
 *  project.floors, as EditorShell does after multi-level edits). */
export async function saveHarnessAll(h: Harness): Promise<Record<string, string>> {
  const ds = memoryDataSource({
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }, null, 2) + '\n',
  });
  const s = h.state;
  await persistLevels(s.project!.levels, ds);
  await persistGrids([], ds);
  for (const level of s.project!.levels) {
    const doc = s.document!.levelId === level.id
      ? s.document!
      : createDocument(level.id, parseFloorLayers(s.project!.floors.get(level.id)?.layers ?? []));
    await persistDocument(doc, ds, undefined, level.elevation, s.project!.types);
  }
  for (const [k, v] of Object.entries(ds.files)) if (v === '') delete ds.files[k];
  return ds.files;
}

/**
 * A small house authored with the drawing tools: walls, a door, a window, two
 * rooms, a slab, a roof, a stair, a column, plus a few MEP elements.
 */
export function authorHouse(): Harness {
  const h = createHarness();
  h.pick('wall');
  // The wall tool chains: one closed outline, then the partition on its own.
  for (const [x, y] of [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('wall'); h.click(6, 0); h.click(6, 8); h.done();
  h.pick('door'); h.click(6, 4); h.done();
  h.pick('window'); h.click(8, 0); h.done();
  h.pick('space'); h.click(3, 4); h.click(8, 4); h.done();
  h.pick('slab');
  for (const [x, y] of [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('roof');
  for (const [x, y] of [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('stair'); h.click(1, 1); h.click(1, 6.04); h.done(); // 18 × 167 mm risers, 280 mm going
  h.pick('column'); h.click(3, 7.5); h.done();
  // MEP, connected end to end (bimdown build reports open ends): an FCU
  // feeding a diffuser (duct out of its SA port, elbow, drop onto the
  // diffuser neck), and hot water from a heater to a basin (riser, run,
  // drop and stub into the basin's hot inlet).
  h.pick('equipment', { __starter_key: 'fcu_chw_2pipe' }); h.click(3, 6); h.done();
  h.pick('terminal', { __starter_key: 'diffuser_supply' }); h.click(1, 3); h.done();
  h.pick('duct'); h.click(2.5, 6); h.click(1, 6); h.click(1, 3); h.done();
  h.pick('equipment', { __starter_key: 'water_heater' }); h.click(8, 2); h.done();
  h.pick('terminal', { __starter_key: 'lavatory' }); h.click(7.95, 6); h.done();
  h.pick('pipe', { start_z: '2.2', size_x: '0.02' }); h.click(7.85, 2); h.click(7.85, 5.775); h.done();
  return h;
}
