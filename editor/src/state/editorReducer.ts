import type { EditorState, EditorAction } from './editorTypes.ts';
import type { SnapType } from '../utils/snap.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement } from '../model/elements.ts';
import { emptyHistory, pushCommand, applyUndo, applyRedo, createCommand } from '../model/history.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import { generateId, toElementId, toSelectionId } from '../model/ids.ts';
import { resolveHostedGeometry, computeHostedPosition } from '../geometry/hosted.ts';
import { arcLength } from '../geometry/arc.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { isVerticalSpanTable, lineWidthAttrForTable, pointSizeAttrsForTable } from '../model/tableRegistry.ts';
import { collectMepBranch, isMepLineTable } from '../model/mepTopology.ts';
import { bondEndpoints } from '../model/bondEndpoints.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { serializeToGeoJson, groupByLayer } from '../model/serialize.ts';
import type { EditCommand, LevelSnapshot } from '../model/history.ts';
import { parseLayer } from '../model/parse.ts';
import type { LayerData } from '../types.ts';
import { getElementModule } from '../elements/registry.ts';
import { portRefTargetsHost } from '../utils/portRef.ts';
import { pickStartLevel } from './startLevel.ts';
import { applyMoveJoins, applyReshapeJoins, rehostChildren } from '../geometry/wallJoins.ts';
import { reresolveElements, reresolveProject, retypeElements } from './typeEdits.ts';
import { EMPTY_CATALOG, reresolveTypeAttrs } from '../model/types/catalog.ts';
import { withDefaultDrawingType } from '../model/types/drawingType.ts';
import { loadViewOptions, saveViewOptions } from './viewOptions.ts';
import { followColumnMoves } from '../model/framingCascade.ts';
import { initialViewsState } from '../views/viewTypes.ts';
import { isViewsAction, viewsReducer } from '../views/viewsReducer.ts';

/** Tables hidden by default (user can toggle on via layer panel). */
const HIDDEN_BY_DEFAULT = new Set(['ceiling']);

/** localStorage key for the user's disabled snap types (persists across reloads). */
const DISABLED_SNAP_KEY = 'bimdown-disabled-snap-types';

function loadDisabledSnapTypes(): Set<SnapType> {
  try {
    const raw = localStorage.getItem(DISABLED_SNAP_KEY);
    if (raw) return new Set(JSON.parse(raw) as SnapType[]);
  } catch { /* ignore malformed / unavailable storage */ }
  return new Set();
}

function saveDisabledSnapTypes(types: Set<SnapType>): void {
  try {
    localStorage.setItem(DISABLED_SNAP_KEY, JSON.stringify([...types]));
  } catch { /* ignore unavailable storage */ }
}

/** Add all non-hidden layer keys from every floor to a visibleLayers set. */
function addAllFloorLayers(visibleLayers: Set<string>, floors: Map<string, import('../types.ts').FloorData>): void {
  for (const [, f] of floors) {
    for (const l of f.layers) {
      if (!HIDDEN_BY_DEFAULT.has(l.tableName)) {
        visibleLayers.add(`${l.discipline}/${l.tableName}`);
      }
    }
  }
}

export const initialState: EditorState = {
  modelName: '',
  project: null,
  grids: [],
  loading: true,

  currentLevel: '',

  viewMode: '2d',
  floor3DMode: 'all',

  readonly: false,
  visibleLayers: new Set(),
  showGrid: true,
  showMinimap: false,
  disabledSnapTypes: loadDisabledSnapTypes(),

  activeTool: 'select',
  previousTool: 'select',
  activeFilter: null,
  activeDiscipline: null,
  showArchContext: true,
  viewOptions: loadViewOptions(),
  spaceHeld: false,

  selectedIds: new Set(),
  hoveredId: null,

  marquee: null,

  document: null,
  history: emptyHistory,
  editMode: false,
  drawingTarget: null,
  drawingAttrs: {},
  drawingState: null,
  documentVersion: 0,
  lastMutation: null,

  views: initialViewsState,
};

/** Collect discipline/tableName keys from element maps for lastMutation tracking */
function collectMutationKeys(...maps: Map<string, CanonicalElement | null>[]): string[] {
  const keys = new Set<string>();
  for (const map of maps) {
    for (const el of map.values()) if (el) keys.add(`${el.discipline}/${el.tableName}`);
  }
  return Array.from(keys);
}

/**
 * Run the MEP endpoint-bonding pass and merge any resulting patches into
 * `nextElements` + the history before/after maps. Mutates `before` / `after`
 * in place; returns the (possibly extended) elements map. Skips quickly when
 * no MEP curves changed.
 */
function applyEndpointBonding(
  nextElements: Map<string, CanonicalElement>,
  candidatePipeIds: Iterable<string>,
  before: Map<string, CanonicalElement | null>,
  after: Map<string, CanonicalElement | null>,
): Map<string, CanonicalElement> {
  const candidates: string[] = [];
  for (const id of candidatePipeIds) {
    const el = nextElements.get(id);
    if (el && isMepLineTable(el.tableName)) candidates.push(id);
  }
  if (candidates.length === 0) return nextElements;
  const bond = bondEndpoints(nextElements, candidates);
  if (!bond) return nextElements;

  const next = new Map(nextElements);
  for (const el of bond.newElements) {
    next.set(el.id, el);
    if (!before.has(el.id)) before.set(el.id, null);
    after.set(el.id, el);
  }
  for (const [id, el] of bond.updates) {
    if (!before.has(id)) before.set(id, nextElements.get(id) ?? null);
    next.set(id, el);
    after.set(id, el);
  }
  return next;
}

/** Garbage-collect passive mep_node rows that no longer serve any purpose
 *  (< 2 MEP curves reference them via `from`/`to`). Active fittings — those
 *  with `kind` set (valve / damper / pump / …) — are user-placed and never
 *  auto-removed. Mutates `nextElements`, `before`, `after` in place and
 *  returns the (possibly trimmed) elements map. */
function cleanupOrphanMepNodes(
  nextElements: Map<string, CanonicalElement>,
  before: Map<string, CanonicalElement | null>,
  after: Map<string, CanonicalElement | null>,
): Map<string, CanonicalElement> {
  // Index mep_node ids (raw + level-stripped) so port-ref hostId values
  // resolve regardless of which form was written.
  const nodeById = new Map<string, CanonicalElement>();
  const nodeByStripped = new Map<string, CanonicalElement>();
  for (const el of nextElements.values()) {
    if (el.tableName !== 'mep_node') continue;
    nodeById.set(el.id, el);
    const colon = el.id.indexOf(':');
    if (colon >= 0) nodeByStripped.set(el.id.substring(colon + 1), el);
  }
  if (nodeById.size === 0) return nextElements;

  type RefEntry = { pipeId: string; side: 'from' | 'to'; nodeId: string };
  const refs: RefEntry[] = [];
  const counts = new Map<string, number>();
  for (const el of nextElements.values()) {
    if (el.tableName !== 'duct' && el.tableName !== 'pipe' &&
        el.tableName !== 'conduit' && el.tableName !== 'cable_tray') continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    for (const side of ['from', 'to'] as const) {
      const parsed = parsePortRef(el.attrs[side]);
      if (!parsed) continue;
      const node = nodeById.get(parsed.hostId) ?? nodeByStripped.get(parsed.hostId);
      if (!node) continue;
      refs.push({ pipeId: el.id, side, nodeId: node.id });
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    }
  }

  const doomed = new Set<string>();
  for (const node of nodeById.values()) {
    // Active fittings are user-placed — never auto-delete.
    if ((node.attrs.kind ?? '').trim()) continue;
    if ((counts.get(node.id) ?? 0) < 2) doomed.add(node.id);
  }
  if (doomed.size === 0) return nextElements;

  const next = new Map(nextElements);
  for (const id of doomed) {
    const original = nextElements.get(id);
    if (!before.has(id)) before.set(id, original ?? null);
    after.set(id, null);
    next.delete(id);
  }
  // Clear refs that point at the doomed nodes so surviving pipes don't
  // carry dangling `host_id` strings forward.
  for (const r of refs) {
    if (!doomed.has(r.nodeId)) continue;
    const pipe = next.get(r.pipeId);
    if (!pipe) continue;
    if (!before.has(pipe.id)) before.set(pipe.id, pipe);
    const updated: CanonicalElement = {
      ...pipe,
      attrs: { ...pipe.attrs, [r.side]: '' },
    };
    next.set(pipe.id, updated);
    after.set(pipe.id, updated);
  }
  return next;
}

/** Actions that mutate the document — blocked in readonly mode. */
const MUTATION_ACTIONS: Set<string> = new Set([
  'CREATE_ELEMENT', 'CREATE_ELEMENTS', 'DELETE_ELEMENTS', 'MOVE_ELEMENTS', 'RESIZE_ELEMENT',
  'UPDATE_ATTRS', 'UPDATE_ATTRS_MANY', 'COMMIT_PREVIEW', 'DUPLICATE_ELEMENTS', 'APPLY_PATCH',
  'UNDO', 'REDO', 'ADD_LEVEL', 'REMOVE_LEVEL', 'RENAME_LEVEL',
  'UPDATE_TYPES', 'SET_ELEMENT_TYPE',
]);

/** Tools allowed in readonly mode — everything else is blocked. */
const READONLY_TOOLS: Set<string> = new Set(['select', 'orbit', 'pan', 'zoom']);

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  // Readonly guard: silently reject all mutation actions
  if (state.readonly && MUTATION_ACTIONS.has(action.type)) return state;

  // Readonly guard: only allow view/navigation tools
  if (state.readonly && action.type === 'SET_TOOL' && !READONLY_TOOLS.has(action.tool)) return state;

  if (isViewsAction(action)) return viewsReducer(state, action);

  switch (action.type) {
    case 'SET_VIEW_MODE': {
      let tool = state.activeTool;
      // Auto-switch between select ↔ orbit when toggling 2D/3D
      if (action.mode === '3d' && tool === 'select') tool = 'orbit';
      if (action.mode === '2d' && tool === 'orbit') tool = 'select';
      // Entering 3D all-floors after a 2D level switch (which keeps only that
      // level's layers): show every floor's layers again, e.g. the columns and
      // foundations of the levels below.
      let visibleLayers = state.visibleLayers;
      if (action.mode === '3d' && state.floor3DMode === 'all' && state.project) {
        visibleLayers = new Set(visibleLayers);
        addAllFloorLayers(visibleLayers, state.project.floors);
      }
      return { ...state, viewMode: action.mode, activeTool: tool, visibleLayers };
    }

    case 'SET_FLOOR_3D_MODE': {
      let visibleLayers = state.visibleLayers;
      // When switching to all-floors mode, include layers from every floor
      if (action.mode === 'all' && state.project) {
        visibleLayers = new Set(visibleLayers);
        addAllFloorLayers(visibleLayers, state.project.floors);
      }
      return { ...state, floor3DMode: action.mode, visibleLayers };
    }

    case 'SET_PROJECT': {
      const { model, project, grids } = action;

      // Preserve current level if it still exists in the new data
      const keepLevel = state.currentLevel && project.levels.some(l => l.id === state.currentLevel);

      let currentLevel = '';
      let visibleLayers = new Set<string>();
      let activeDiscipline: string | null = 'architecture';

      if (keepLevel) {
        currentLevel = state.currentLevel;
        visibleLayers = state.visibleLayers;
        activeDiscipline = state.activeDiscipline;
      } else if (project.floors.size > 0) {
        const startId = pickStartLevel(project) || project.levels.find(l => project.floors.has(l.id))?.id;
        if (startId) {
          currentLevel = startId;
          const floor = project.floors.get(startId);
          if (floor) {
            visibleLayers = new Set(floor.layers
              .filter(l => !HIDDEN_BY_DEFAULT.has(l.tableName))
              .map(l => `${l.discipline}/${l.tableName}`));
          }
        }
      } else if (project.levels.length > 0) {
        // New/empty project: auto-select first level so editor is ready to draw
        currentLevel = project.levels[0].id;
      }
      // Always show grids by default
      if (grids.length > 0) visibleLayers.add('reference/grid');
      // Include global layers (mesh, global railing, etc.)
      for (const gl of project.globalLayers) visibleLayers.add(`${gl.discipline}/${gl.tableName}`);
      // In all-floors 3D mode, include layers from every floor
      if (state.floor3DMode === 'all') addAllFloorLayers(visibleLayers, project.floors);

      const views = model === state.modelName ? state.views : initialViewsState;
      return { ...state, modelName: model, project, grids, loading: false, currentLevel, visibleLayers, activeDiscipline, views };
    }

    case 'SET_LOADING':
      return { ...state, loading: action.loading };

    case 'UPDATE_GRIDS':
      return { ...state, grids: action.grids };

    case 'UPDATE_MEP_SYSTEMS': {
      if (!state.project) return state;
      return { ...state, project: { ...state.project, mepSystems: action.mepSystems } };
    }

    case 'UPDATE_TYPES':
    case 'SET_TYPES': {
      if (!state.project) return state;
      const before = state.project.types ?? EMPTY_CATALOG;
      const after = action.types;
      const project = reresolveProject(state.project, after);
      if (!state.document) return { ...state, project };
      const { next, changed } = reresolveElements(state.document.elements, before, after);
      const b = new Map<string, CanonicalElement | null>();
      const a = new Map<string, CanonicalElement | null>();
      for (const [id, c] of changed) { b.set(id, c.before); a.set(id, c.after); }
      const document = { ...state.document, elements: next };
      // The next element to place follows the edited type too.
      const drawingAttrs = state.drawingTarget
        ? reresolveTypeAttrs(state.drawingTarget.tableName, state.drawingAttrs, before, after)
        : state.drawingAttrs;
      if (action.type === 'SET_TYPES') {
        return { ...state, project, document, drawingAttrs, documentVersion: state.documentVersion + 1 };
      }
      return {
        ...state,
        project,
        document,
        drawingAttrs,
        history: pushCommand(state.history, { ...createCommand(action.description ?? 'Edit types', b, a), types: { before, after } }),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(b, a) },
      };
    }

    case 'SET_ELEMENT_TYPE': {
      if (!state.document || !state.project) return state;
      const types = state.project.types;
      const { next, changed } = retypeElements(state.document.elements, action.ids.map(toElementId), action.typeId, types);
      if (changed.size === 0) return state;
      const b = new Map<string, CanonicalElement | null>();
      const a = new Map<string, CanonicalElement | null>();
      for (const [id, c] of changed) { b.set(id, c.before); a.set(id, c.after); }
      // First use of a starter type writes the catalog to the project.
      const project = action.typeId && types && !types.saved
        ? { ...state.project, types: { ...types, saved: true, fromDisk: false } }
        : state.project;
      return {
        ...state,
        project,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Change type', b, a)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(b, a) },
      };
    }

    case 'UPDATE_LAYER': {
      if (!state.project) return state;
      const { levelId, layer } = action;
      const floors = new Map(state.project.floors);
      
      let floor = floors.get(levelId);
      if (!floor) {
        const levelName = state.project.levels.find(l => l.id === levelId)?.name || levelId;
        floor = { levelId, levelName, layers: [] };
      }
      
      const newLayers = floor.layers.filter(
        l => !(l.discipline === layer.discipline && l.tableName === layer.tableName)
      );
      newLayers.push(layer);

      floors.set(levelId, { ...floor, layers: newLayers });

      // Auto-show new layers (unless hidden by default)
      const layerKey = `${layer.discipline}/${layer.tableName}`;
      const isNew = !floor.layers.some(
        l => l.discipline === layer.discipline && l.tableName === layer.tableName
      );
      const visibleLayers = isNew && !HIDDEN_BY_DEFAULT.has(layer.tableName)
        ? new Set([...state.visibleLayers, layerKey])
        : state.visibleLayers;

      return {
        ...state,
        visibleLayers,
        project: { ...state.project, floors },
      };
    }

    case 'SET_LEVEL': {
      const floor = state.project?.floors.get(action.levelId);
      const visibleLayers = floor
        ? new Set(floor.layers
            .filter(l => !HIDDEN_BY_DEFAULT.has(l.tableName))
            .map(l => `${l.discipline}/${l.tableName}`))
        : new Set<string>();
      // Preserve grid and global layer visibility across levels
      if (state.visibleLayers.has('reference/grid')) visibleLayers.add('reference/grid');
      if (state.project) {
        for (const gl of state.project.globalLayers) visibleLayers.add(`${gl.discipline}/${gl.tableName}`);
        // In 3D all-floors mode, include layers from all floors so other levels render fully
        if (state.viewMode === '3d' && state.floor3DMode === 'all') {
          addAllFloorLayers(visibleLayers, state.project.floors);
        }
      }

      return {
        ...state,
        currentLevel: action.levelId,
        visibleLayers,
        selectedIds: new Set(),
        hoveredId: null,
        activeFilter: null,
      };
    }

    case 'TOGGLE_LAYER': {
      const next = new Set(state.visibleLayers);
      if (next.has(action.key)) next.delete(action.key);
      else next.add(action.key);
      return { ...state, visibleLayers: next };
    }

    case 'SET_VISIBLE_LAYERS':
      return { ...state, visibleLayers: action.keys };

    case 'TOGGLE_GRID':
      return { ...state, showGrid: !state.showGrid };

    case 'TOGGLE_MINIMAP':
      return { ...state, showMinimap: !state.showMinimap };

    case 'TOGGLE_SNAP_CATEGORY': {
      const next = new Set(state.disabledSnapTypes);
      // A category is "on" only when none of its types are disabled. Toggling
      // flips the whole category: enable all (if any was off) else disable all.
      const allEnabled = action.types.every(t => !next.has(t));
      if (allEnabled) {
        for (const t of action.types) next.add(t);
      } else {
        for (const t of action.types) next.delete(t);
      }
      saveDisabledSnapTypes(next);
      return { ...state, disabledSnapTypes: next };
    }

    case 'SET_TOOL': {
      // In 3D mode, 'select' should become 'orbit' (the 3D equivalent default tool)
      let tool = action.tool;
      if (state.viewMode === '3d' && tool === 'select') tool = 'orbit';
      return {
        ...state,
        activeTool: tool,
        previousTool: state.activeTool,
      };
    }

    case 'SET_SPACE_HELD':
      if (action.held && !state.spaceHeld) {
        return {
          ...state,
          spaceHeld: true,
          previousTool: state.activeTool,
          activeTool: 'pan',
        };
      }
      if (!action.held && state.spaceHeld) {
        return {
          ...state,
          spaceHeld: false,
          activeTool: state.previousTool,
        };
      }
      return state;

    case 'SET_FILTER':
      return {
        ...state,
        activeFilter: action.filter === state.activeFilter ? null : action.filter,
      };

    case 'SET_DISCIPLINE':
      return { ...state, activeDiscipline: action.discipline };

    case 'TOGGLE_ARCH_CONTEXT':
      return { ...state, showArchContext: !state.showArchContext };

    case 'TOGGLE_VIEW_OPTION': {
      const viewOptions = { ...state.viewOptions, [action.key]: !state.viewOptions[action.key] };
      saveViewOptions(viewOptions);
      return { ...state, viewOptions };
    }

    case 'SELECT': {
      if (action.additive) {
        const next = new Set(state.selectedIds);
        for (const id of action.ids) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return { ...state, selectedIds: next, editMode: false };
      }
      return { ...state, selectedIds: new Set(action.ids), editMode: false };
    }

    case 'CLEAR_SELECTION':
      return { ...state, selectedIds: new Set(), activeFilter: null, editMode: false };

    case 'SET_HOVER':
      return { ...state, hoveredId: action.id };

    case 'SET_MARQUEE':
      return { ...state, marquee: action.marquee };

    // --- Document editing actions ---

    case 'INIT_DOCUMENT':
      // Element commands belong to the previous level's document; level
      // commands (add / remove / rename) stay undoable across the switch.
      return {
        ...state, document: action.document, documentVersion: 0, lastMutation: null,
        history: {
          undoStack: state.history.undoStack.filter(c => c.level),
          redoStack: state.history.redoStack.filter(c => c.level),
        },
      };

    case 'MOVE_ELEMENTS': {
      if (!state.document) return state;
      const { ids, dx, dy, preview } = action;
      const rawIds = ids.map(toElementId);
      const next = new Map(state.document.elements);
      // Collect hosted elements that should cascade with moved hosts
      const movedSet = new Set(rawIds);
      const allIds = [...rawIds];
      for (const el of next.values()) {
        if (el.hostId && movedSet.has(el.hostId) && !movedSet.has(el.id)) {
          allIds.push(el.id);
          movedSet.add(el.id);
        }
      }
      let changed = false;
      for (const id of allIds) {
        const el = next.get(id);
        if (!el) continue;
        changed = true;
        // Hosted elements (doors/windows/openings) dragged on their own must
        // slide ALONG the host wall, not translate freely off it. Re-project
        // the dragged center onto the host and update the parametric position.
        // Skipped when the host is also moving (cascade) — then a plain
        // translate keeps the element's relative position on the wall.
        if (
          el.hostId && !movedSet.has(el.hostId)
          && (el.geometry === 'line' || el.geometry === 'spatial_line')
        ) {
          const host = next.get(el.hostId) ?? state.document.elements.get(el.hostId);
          if (host && (host.geometry === 'line' || host.geometry === 'spatial_line')) {
            const ln = el as LineElement;
            const width = parseFloat(ln.attrs.width ?? '0.9') || 0.9;
            const center = {
              x: (ln.start.x + ln.end.x) / 2 + dx,
              y: (ln.start.y + ln.end.y) / 2 + dy,
            };
            const pos = computeHostedPosition(host as LineElement, center);
            const { start, end } = resolveHostedGeometry(host as LineElement, pos, width);
            next.set(id, {
              ...ln, start, end, locationParam: pos,
              attrs: { ...ln.attrs, position: String(pos) },
            });
            continue;
          }
        }
        next.set(id, moveElement(el, dx, dy));
      }
      // Topology cascade: when an equipment / terminal / mep_node host moves,
      // only the matching endpoint(s) of every pipe/duct/conduit/cable_tray
      // whose `from` / `to` references the host (with or without :port_name
      // suffix) should follow — the rest of the pipe stays where it is.
      // Pipes already in `movedSet` (fully translated above) are skipped to
      // avoid double-moving.
      const partialMoved = new Set<string>();
      const HOST_TABLES = new Set(['mep_node', 'equipment', 'terminal']);
      for (const movedId of allIds) {
        const movedEl = next.get(movedId);
        if (!movedEl || !HOST_TABLES.has(movedEl.tableName)) continue;
        const colonIdx = movedId.indexOf(':');
        const unprefixedNodeId = colonIdx >= 0 ? movedId.substring(colonIdx + 1) : movedId;
        const targetsMoved = (ref: string | undefined): boolean =>
          portRefTargetsHost(ref, movedId) || portRefTargetsHost(ref, unprefixedNodeId);
        for (const el of state.document.elements.values()) {
          if (
            el.tableName !== 'duct' && el.tableName !== 'pipe'
            && el.tableName !== 'conduit' && el.tableName !== 'cable_tray'
          ) continue;
          if (movedSet.has(el.id)) continue;
          const startMatch = targetsMoved(el.attrs.from);
          const endMatch   = targetsMoved(el.attrs.to);
          if (!startMatch && !endMatch) continue;
          const currentPipe = next.get(el.id) ?? el;
          if (currentPipe.geometry !== 'line' && currentPipe.geometry !== 'spatial_line') continue;
          const ln = currentPipe as LineElement;
          const newStart = startMatch ? { x: ln.start.x + dx, y: ln.start.y + dy } : ln.start;
          const newEnd   = endMatch   ? { x: ln.end.x   + dx, y: ln.end.y   + dy } : ln.end;
          next.set(el.id, { ...ln, start: newStart, end: newEnd });
          partialMoved.add(el.id);
          changed = true;
        }
      }
      // Wall joins: corner and tee neighbours stay attached to moved walls.
      // Drag previews must pass the joins snapshotted at drag start.
      const moveJoins = preview ? action.wallJoins ?? [] : action.wallJoins;
      for (const id of applyMoveJoins(state.document.elements, next, movedSet, moveJoins, dx, dy)) {
        if (!movedSet.has(id)) partialMoved.add(id);
        changed = true;
      }
      // Framing cascade: a beam / brace end that frames into a moved column
      // (lies inside its footprint) follows it; the other end stays put.
      for (const id of followColumnMoves(state.document.elements, next, allIds, movedSet, dx, dy)) {
        partialMoved.add(id);
        changed = true;
      }
      if (!changed) return state;
      if (preview) {
        return { ...state, document: { ...state.document, elements: next } };
      }
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      for (const id of allIds) {
        const pre = state.document.elements.get(id);
        const post = next.get(id);
        before.set(id, pre ?? null);
        after.set(id, post ?? null);
      }
      // Partial-moved pipes also recorded so undo restores their endpoints.
      for (const id of partialMoved) {
        const pre = state.document.elements.get(id);
        const post = next.get(id);
        before.set(id, pre ?? null);
        after.set(id, post ?? null);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Move elements', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before, after) }
      };
    }

    case 'CREATE_ELEMENT': {
      if (!state.document) return state;
      const before = new Map<string, CanonicalElement | null>([[action.element.id, null]]);
      const after = new Map<string, CanonicalElement | null>([[action.element.id, action.element]]);
      let next = new Map(state.document.elements);
      next.set(action.element.id, action.element);
      // Auto-show layer if not yet visible
      const layerKey = `${action.element.discipline}/${action.element.tableName}`;
      const visibleLayers = state.visibleLayers.has(layerKey)
        ? new Set(state.visibleLayers)
        : new Set([...state.visibleLayers, layerKey]);
      // Endpoint bonding: if this is a MEP curve, weld coincident endpoints
      // by auto-creating / reusing a passive mep_node and rewriting from/to.
      next = applyEndpointBonding(next, [action.element.id], before, after);
      // GC any passive mep_nodes that ended up with < 2 references.
      next = cleanupOrphanMepNodes(next, before, after);
      // Make sure any bonded-in mep_node layer becomes visible too.
      for (const el of after.values()) {
        if (!el) continue;
        visibleLayers.add(`${el.discipline}/${el.tableName}`);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Create element', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before, after) },
        selectedIds: state.drawingTarget ? state.selectedIds : new Set([action.element.id]),
        visibleLayers,
        // Sequential defaults (Room N, number) advance with every placement.
        drawingAttrs: state.drawingTarget?.tableName === action.element.tableName
          ? { ...state.drawingAttrs, ...autoFillFor(action.element.tableName, next) }
          : state.drawingAttrs,
      };
    }

    case 'APPLY_PATCH': {
      if (!state.document || action.patches.size === 0) return state;
      let next = new Map(state.document.elements);
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const visibleLayers = new Set(state.visibleLayers);
      const candidatePipeIds: string[] = [];
      // Callers can override `before` per element when the live document
      // already reflects an in-flight preview (e.g. resize handle mid-drag)
      // and the history should record the *pre-preview* state instead.
      const explicitBefore = action.before;
      for (const [id, value] of action.patches) {
        const beforeVal = explicitBefore?.has(id)
          ? explicitBefore.get(id)!
          : state.document.elements.get(id) ?? null;
        before.set(id, beforeVal);
        after.set(id, value);
        if (value === null) {
          next.delete(id);
        } else {
          next.set(id, value);
          const layerKey = `${value.discipline}/${value.tableName}`;
          visibleLayers.add(layerKey);
          if (isMepLineTable(value.tableName)) candidatePipeIds.push(id);
        }
      }
      next = applyEndpointBonding(next, candidatePipeIds, before, after);
      next = cleanupOrphanMepNodes(next, before, after);
      for (const el of after.values()) {
        if (!el) continue;
        visibleLayers.add(`${el.discipline}/${el.tableName}`);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand(action.description, before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before, after) },
        visibleLayers,
      };
    }

    case 'CREATE_ELEMENTS': {
      if (!state.document || action.elements.length === 0) return state;
      let next = new Map(state.document.elements);
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const visibleLayers = new Set(state.visibleLayers);
      const candidatePipeIds: string[] = [];
      for (const el of action.elements) {
        before.set(el.id, null);
        after.set(el.id, el);
        next.set(el.id, el);
        visibleLayers.add(`${el.discipline}/${el.tableName}`);
        if (isMepLineTable(el.tableName)) candidatePipeIds.push(el.id);
      }
      next = applyEndpointBonding(next, candidatePipeIds, before, after);
      next = cleanupOrphanMepNodes(next, before, after);
      for (const el of after.values()) {
        if (!el) continue;
        visibleLayers.add(`${el.discipline}/${el.tableName}`);
      }
      const description = action.description ?? `Create ${action.elements.length} elements`;
      const primary = action.selectPrimary !== false ? action.elements[0] : null;
      const nextSelection = primary && !state.drawingTarget
        ? new Set([primary.id])
        : state.selectedIds;
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand(description, before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before, after) },
        selectedIds: nextSelection,
        visibleLayers,
      };
    }

    case 'DELETE_ELEMENTS': {
      if (!state.document) return state;
      const rawIds = action.ids.map(toElementId);
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const next = new Map(state.document.elements);
      const deletedRawSet = new Set(rawIds);
      // Delete requested elements
      for (const id of rawIds) {
        const el = next.get(id);
        if (el) {
          before.set(id, el);
          after.set(id, null);
          next.delete(id);
        }
      }
      // Cascade delete hosted elements whose host was deleted
      for (const [id, el] of next) {
        if (el.hostId && deletedRawSet.has(el.hostId)) {
          before.set(id, el);
          after.set(id, null);
          next.delete(id);
          deletedRawSet.add(id);
        }
      }
      if (before.size === 0) return state;
      // GC passive mep_nodes that lost their last MEP-curve reference when
      // pipes / ducts were deleted above.
      const gced = cleanupOrphanMepNodes(next, before, after);
      // Remove deleted IDs from selection (match both prefixed and raw)
      const nextSelected = new Set(state.selectedIds);
      for (const sid of state.selectedIds) {
        if (deletedRawSet.has(toElementId(sid))) nextSelected.delete(sid);
      }

      return {
        ...state,
        document: { ...state.document, elements: gced },
        history: pushCommand(state.history, createCommand('Delete elements', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before) },
        selectedIds: nextSelected,
        editMode: false,
      };
    }

    case 'DUPLICATE_ELEMENTS': {
      if (!state.document) return state;
      const { ids, offset } = action;
      const rawIds = ids.map(toElementId);
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const next = new Map(state.document.elements);
      const existingIds = new Set(next.keys());
      const newSelectionIds: string[] = [];
      // Hosted children (doors / windows / openings on a wall, stair runs,
      // equipment ports) travel with a duplicated host, re-hosted on the copy.
      const selected = new Set(rawIds.filter(id => next.has(id)));
      const children: string[] = [];
      for (const el of state.document.elements.values()) {
        if (el.hostId && selected.has(el.hostId) && !selected.has(el.id)) children.push(el.id);
      }
      const newIdOf = new Map<string, string>();
      for (const rawId of [...selected, ...children]) {
        const newId = generateId(next.get(rawId)!.tableName, existingIds);
        existingIds.add(newId);
        newIdOf.set(rawId, newId);
      }
      for (const [rawId, newId] of newIdOf) {
        const el = next.get(rawId)!;
        let cloned: CanonicalElement = { ...moveElement(el, offset.dx, offset.dy), id: newId, attrs: { ...el.attrs, id: newId } };
        const newHost = el.hostId ? newIdOf.get(el.hostId) : undefined;
        if (newHost) {
          cloned = { ...cloned, hostId: newHost, attrs: { ...cloned.attrs, host_id: newHost } };
        } else if (el.hostId) {
          // Copied without its host: stay on the same host, slid along it.
          cloned = slideOnHost(cloned, el, state.document.elements.get(el.hostId), offset);
        }
        next.set(newId, cloned);
        before.set(newId, null);
        after.set(newId, cloned);
        // Selection IDs keep the level prefix (children are not selected)
        if (selected.has(rawId)) newSelectionIds.push(state.currentLevel ? toSelectionId(state.currentLevel, newId) : newId);
      }
      if (newSelectionIds.length === 0) return state;
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Duplicate elements', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(after) },
        selectedIds: new Set(newSelectionIds),
      };
    }

    case 'UPDATE_ATTRS': {
      if (!state.document) return state;
      const rawId = toElementId(action.id);
      const el = state.document.elements.get(rawId);
      if (!el) return state;
      const before = new Map<string, CanonicalElement | null>([[rawId, el]]);
      const updated = { ...el, attrs: { ...el.attrs, ...action.attrs } };

      // Sync plan-size attrs (size_x/size_y; foundation width/length) → PointElement width/height
      if (updated.geometry === 'point') {
        const pt = updated as PointElement;
        const [sx, sy] = pointSizeAttrsForTable(updated.tableName);
        if (sx in action.attrs) pt.width = parseFloat(action.attrs[sx]) || pt.width;
        if (sy in action.attrs) pt.height = parseFloat(action.attrs[sy]) || pt.height;
      }

      // Sync the plan-width attr (thickness; strip footing width) → strokeWidth.
      // Without this, wall/beam/duct geometry stays at the old thickness even
      // though the CSV row shows the new value.
      const widthAttr = lineWidthAttrForTable(updated.tableName);
      if ((updated.geometry === 'line' || updated.geometry === 'spatial_line') && widthAttr in action.attrs) {
        const t = parseFloat(action.attrs[widthAttr]);
        if (Number.isFinite(t) && t > 0) (updated as LineElement).strokeWidth = t;
      }
      // Same for a section's plan width (duct / pipe / beam size_x, diameter).
      if ((updated.geometry === 'line' || updated.geometry === 'spatial_line') && 'size_x' in action.attrs && !updated.hostId) {
        const w = resolveLineStrokeWidth(updated.tableName, updated.attrs);
        if (w != null) (updated as LineElement).strokeWidth = w;
      }

      // Sync start_z/end_z attrs → SpatialLineElement startZ/endZ fields.
      // The 3D renderer + serializer read the fields (not attrs), so without
      // this an edited slope (start_z ≠ end_z) would still render/save flat.
      if (updated.geometry === 'spatial_line') {
        const sp = updated as SpatialLineElement;
        if ('start_z' in action.attrs) {
          const z = parseFloat(action.attrs.start_z);
          if (Number.isFinite(z)) sp.startZ = z;
        }
        if ('end_z' in action.attrs) {
          const z = parseFloat(action.attrs.end_z);
          if (Number.isFinite(z)) sp.endZ = z;
        }
      }

      // Re-resolve hosted geometry when position, width, or host_id changes
      if (updated.hostId && updated.geometry === 'line' && ('position' in action.attrs || 'width' in action.attrs || 'host_id' in action.attrs)) {
        const hostWall = state.document.elements.get(action.attrs.host_id ?? updated.hostId ?? '');
        if (hostWall && (hostWall.geometry === 'line' || hostWall.geometry === 'spatial_line')) {
          const pos = parseFloat(updated.attrs.position ?? '0.5');
          const width = parseFloat(updated.attrs.width ?? '0.9');
          const { start, end } = resolveHostedGeometry(hostWall as LineElement, pos, width);
          (updated as LineElement).start = start;
          (updated as LineElement).end = end;
          (updated as LineElement).locationParam = pos;
        }
      }

      const after = new Map<string, CanonicalElement | null>([[rawId, updated]]);
      const next = new Map(state.document.elements);
      next.set(rawId, updated);

      // Branch propagation: when the edit changes system_type on an MEP curve,
      // walk the connected branch (same table, same OLD system_type) via the
      // from/to port-ref topology and re-tag every curve in one atomic command.
      if (
        'system_type' in action.attrs
        && action.attrs.system_type !== (el.attrs.system_type ?? '')
        && isMepLineTable(updated.tableName)
      ) {
        const oldSys = el.attrs.system_type ?? '';
        const newSys = action.attrs.system_type ?? '';
        const branchIds = collectMepBranch(state.document.elements, updated, oldSys);
        for (const branchId of branchIds) {
          if (branchId === rawId) continue;
          const bel = state.document.elements.get(branchId);
          if (!bel) continue;
          before.set(branchId, bel);
          const bnext = { ...bel, attrs: { ...bel.attrs, system_type: newSys } };
          after.set(branchId, bnext);
          next.set(branchId, bnext);
        }
      }

      // Auto-migrate to globalLayers when top_level_id skips levels
      if ('top_level_id' in action.attrs && isVerticalSpanTable(updated.tableName) && state.project) {
        const migrated = maybeMigrateToGlobal(updated, state);
        if (migrated) {
          next.delete(rawId);
          return {
            ...state,
            document: { ...state.document, elements: next },
            project: migrated,
            history: pushCommand(state.history, createCommand('Migrate to global', before, new Map([[rawId, null]]))),
            documentVersion: state.documentVersion + 1,
            lastMutation: { version: state.documentVersion + 1, keys: [`${updated.discipline}/${updated.tableName}`, `__global__/${updated.tableName}`] },
            selectedIds: new Set(),
          };
        }
      }

      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Update properties', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: [`${updated.discipline}/${updated.tableName}`] }
      };
    }

    case 'UPDATE_ATTRS_MANY': {
      // Apply UPDATE_ATTRS per element (keeps all its syncing rules), then
      // fold the commands it pushed into one undo step.
      const original = new Set(state.history.undoStack);
      const keys = new Set<string>();
      let s = state;
      for (const id of action.ids) {
        s = editorReducer(s, { type: 'UPDATE_ATTRS', id, attrs: action.attrs });
        if (s.lastMutation && s.lastMutation !== state.lastMutation) for (const k of s.lastMutation.keys) keys.add(k);
      }
      const added = s.history.undoStack.filter(c => !original.has(c));
      if (added.length === 0) return s;
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      for (const c of added) {
        for (const [id, el] of c.before) if (!before.has(id)) before.set(id, el);
        for (const [id, el] of c.after) after.set(id, el);
      }
      let kept = s.history.undoStack.filter(c => original.has(c));
      // Typing "0.35" edits the field three times: keep it one undo step.
      const mergeKey = `${[...action.ids].sort().join(',')}|${Object.keys(action.attrs).sort().join(',')}`;
      const prev = kept[kept.length - 1];
      if (prev?.mergeKey === mergeKey) {
        for (const [id, el] of prev.before) before.set(id, el);
        kept = kept.slice(0, -1);
      }
      return {
        ...s,
        history: { undoStack: [...kept, { ...createCommand('Update properties', before, after), mergeKey }], redoStack: [] },
        lastMutation: { version: s.documentVersion, keys: [...keys] },
      };
    }

    case 'RESIZE_ELEMENT': {
      if (!state.document) return state;
      const rawId = toElementId(action.id);
      const el = state.document.elements.get(rawId);
      if (!el) return state;
      let resized = applyResize(el, action.changes);

      // Keep a hosted element (door/window/opening) on its host wall when its
      // own endpoints are dragged: project both ends onto the host, then derive
      // parametric position + width and re-resolve geometry. Without this, the
      // default line-endpoint handles would pull it off the wall.
      if (
        el.hostId
        && (resized.geometry === 'line' || resized.geometry === 'spatial_line')
        && ('start' in action.changes || 'end' in action.changes)
      ) {
        const host = state.document.elements.get(el.hostId);
        if (host && (host.geometry === 'line' || host.geometry === 'spatial_line')) {
          const ln = resized as LineElement;
          const tA = computeHostedPosition(host as LineElement, ln.start);
          const tB = computeHostedPosition(host as LineElement, ln.end);
          const width = Math.max(0.05, Math.abs(tB - tA));
          const position = (tA + tB) / 2;
          const { start, end } = resolveHostedGeometry(host as LineElement, position, width);
          resized = {
            ...ln, start, end, locationParam: position,
            attrs: { ...ln.attrs, position: String(position), width: String(width) },
          };
        }
      }

      const next = new Map(state.document.elements);
      next.set(rawId, resized);

      // Re-resolve hosted elements when their host wall is resized: each keeps
      // its distance from the end that stayed put.
      if (resized.geometry === 'line' || resized.geometry === 'spatial_line') {
        rehostChildren(next, el as LineElement, resized as LineElement);
      }
      // Wall joins: corner neighbours follow a dragged end, tees stay on the body.
      const joinTouched = applyReshapeJoins(
        state.document.elements, next, el, action.preview ? action.wallJoins ?? [] : action.wallJoins,
      );

      // Topology cascade (reverse of MOVE_ELEMENTS' host case):
      // When a pipe/duct/conduit/cable_tray's endpoint moves, drag the
      // connected mep_node along with it AND every other pipe sharing that
      // node. Equipment/terminal hosts are intentionally NOT dragged this way
      // (they're authored, not derived); only passive mep_node hosts cascade.
      const partialMoved = new Set<string>(joinTouched);
      const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);
      if (MEP_TABLES.has(el.tableName)
          && (el.geometry === 'line' || el.geometry === 'spatial_line')
          && (resized.geometry === 'line' || resized.geometry === 'spatial_line')) {
        const original = el as LineElement;
        const after = resized as LineElement;
        const startChanged = original.start.x !== after.start.x || original.start.y !== after.start.y;
        const endChanged = original.end.x !== after.end.x || original.end.y !== after.end.y;

        const parsePortRef = (ref: string | undefined): string | null => {
          if (!ref) return null;
          const colon = ref.indexOf(':');
          return colon < 0 ? ref : ref.substring(0, colon);
        };

        for (const [portRefAttr, dragged, changed] of [
          ['from', { dx: after.start.x - original.start.x, dy: after.start.y - original.start.y }, startChanged],
          ['to',   { dx: after.end.x   - original.end.x,   dy: after.end.y   - original.end.y   }, endChanged],
        ] as const) {
          if (!changed) continue;
          const nodeIdRaw = parsePortRef(original.attrs[portRefAttr]);
          if (!nodeIdRaw) continue;
          // Match prefixed and unprefixed; nodes may live with or without level prefix.
          const colonIdx = rawId.indexOf(':');
          const prefix = colonIdx >= 0 ? rawId.substring(0, colonIdx + 1) : '';
          const prefixedNodeId = prefix && !nodeIdRaw.includes(':') ? prefix + nodeIdRaw : nodeIdRaw;
          const node = next.get(prefixedNodeId) ?? next.get(nodeIdRaw);
          if (!node || node.tableName !== 'mep_node' || node.geometry !== 'point') continue;
          const movedNode = moveElement(node, dragged.dx, dragged.dy);
          next.set(node.id, movedNode);
          partialMoved.add(node.id);
          // Drag every other pipe sharing this node by the same delta on its
          // matching endpoint.
          const nodeRaw = node.id;
          const nodeUnpref = nodeRaw.includes(':') ? nodeRaw.substring(nodeRaw.indexOf(':') + 1) : nodeRaw;
          const otherTargets = (ref: string | undefined): boolean =>
            portRefTargetsHost(ref, nodeRaw) || portRefTargetsHost(ref, nodeUnpref);
          for (const other of state.document.elements.values()) {
            if (other.id === rawId) continue;
            if (!MEP_TABLES.has(other.tableName)) continue;
            if (other.geometry !== 'line' && other.geometry !== 'spatial_line') continue;
            const sMatch = otherTargets(other.attrs.from);
            const eMatch = otherTargets(other.attrs.to);
            if (!sMatch && !eMatch) continue;
            const cur = next.get(other.id) ?? other;
            if (cur.geometry !== 'line' && cur.geometry !== 'spatial_line') continue;
            const ln = cur as LineElement;
            const newStart = sMatch ? { x: ln.start.x + dragged.dx, y: ln.start.y + dragged.dy } : ln.start;
            const newEnd   = eMatch ? { x: ln.end.x   + dragged.dx, y: ln.end.y   + dragged.dy } : ln.end;
            next.set(other.id, { ...ln, start: newStart, end: newEnd });
            partialMoved.add(other.id);
          }
        }
      }

      if (action.preview) {
        return { ...state, document: { ...state.document, elements: next } };
      }
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      before.set(rawId, el);
      after.set(rawId, resized);
      // Include re-resolved hosted elements in undo history
      for (const [id, hosted] of next) {
        if (id !== rawId && hosted.hostId === rawId) {
          before.set(id, state.document.elements.get(id) ?? null);
          after.set(id, hosted);
        }
      }
      // Topology-cascaded elements (mep_node + other connected pipes) in undo too.
      for (const id of partialMoved) {
        before.set(id, state.document.elements.get(id) ?? null);
        after.set(id, next.get(id) ?? null);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Resize element', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: [`${resized.discipline}/${resized.tableName}`] }
      };
    }

    case 'COMMIT_PREVIEW': {
      if (!state.document) return state;
      // Endpoint bonding: when the preview that's being committed includes
      // MEP curves, run a bonding pass against the LIVE document state
      // (which already reflects the preview's mutations) so coincident
      // endpoints get welded with a passive mep_node — and merge the
      // resulting patches into THIS history entry for clean undo.
      const before = new Map(action.before);
      const after = new Map(action.after);
      const candidatePipeIds: string[] = [];
      for (const [id, el] of action.after) {
        if (el && isMepLineTable(el.tableName)) candidatePipeIds.push(id);
      }
      let nextElements = state.document.elements;
      if (candidatePipeIds.length > 0) {
        const bonded = applyEndpointBonding(new Map(state.document.elements), candidatePipeIds, before, after);
        if (bonded !== state.document.elements) nextElements = bonded;
      }
      // Always run the passive-node GC: pipe endpoint drags can leave a node
      // with < 2 references even without a bonding pass.
      const gced = cleanupOrphanMepNodes(new Map(nextElements), before, after);
      if (gced !== nextElements) nextElements = gced;
      const documentChanged = nextElements !== state.document.elements;
      return {
        ...state,
        document: documentChanged ? { ...state.document, elements: nextElements } : state.document,
        history: pushCommand(state.history, createCommand(action.description, before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(before, after) }
      };
    }

    case 'UNDO': {
      if (state.history.undoStack.length === 0) return state;
      const cmd = state.history.undoStack[state.history.undoStack.length - 1];
      if (cmd.level) return undoLevelCommand(state, cmd);
      if (!state.document) return state;
      const result = applyUndo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
        // A type edit: restore the catalog; other levels re-resolve against it
        // (the document's elements come back from the command's snapshots).
        // (saved: the files on disk hold the edited types and must be rewritten)
        project: cmd.types && state.project ? reresolveProject(state.project, { ...cmd.types.before, saved: true, fromDisk: false }) : state.project,
        document: { ...state.document, elements: result.elements },
        history: result.history,
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(cmd.before, cmd.after) }
      };
    }

    case 'REDO': {
      if (state.history.redoStack.length === 0) return state;
      const cmd = state.history.redoStack[state.history.redoStack.length - 1];
      if (cmd.level) return redoLevelCommand(state, cmd);
      if (!state.document) return state;
      const result = applyRedo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
        project: cmd.types && state.project ? reresolveProject(state.project, { ...cmd.types.after, saved: true, fromDisk: false }) : state.project,
        document: { ...state.document, elements: result.elements },
        history: result.history,
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(cmd.before, cmd.after) }
      };
    }

    case 'SET_EDIT_MODE':
      return { ...state, editMode: action.active };

    case 'SET_DRAWING_STATE':
      return { ...state, drawingState: action.state };

    case 'SET_DRAWING_TARGET': {
      let attrs: Record<string, string> = {};
      if (action.target) {
        attrs = getDefaultDrawingAttrs(action.target.tableName, state.currentLevel, state.project?.levels, action.target.variantId);
        // Modules opt in to sequential defaults / other tool-activation
        // auto-fills via `autoFillOnPlace`. Counts existing elements of this
        // table so each placement bumps the next default value.
        if (state.document) {
          Object.assign(attrs, autoFillFor(action.target.tableName, state.document.elements));
          const defaults = getElementModule(action.target.tableName)?.placementDefaults?.({
            elements: state.document.elements, levels: state.project?.levels ?? [], levelId: state.currentLevel,
          });
          if (defaults) Object.assign(attrs, defaults);
        }
        attrs = withDefaultDrawingType(action.target.tableName, attrs, state.project?.types);
      }
      return { ...state, drawingTarget: action.target, drawingAttrs: attrs };
    }

    case 'SET_DRAWING_ATTRS':
      return { ...state, drawingAttrs: action.attrs };

    case 'RELOAD_ELEMENTS': {
      if (!state.document) return state;
      const next = new Map(state.document.elements);
      for (const el of action.elements) {
        next.set(el.id, el);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
      };
    }

    case 'EXTERNAL_LAYER_UPDATE': {
      if (!state.document) return state;
      // Only merge into document if the update is for the currently viewed level
      if (action.levelId !== state.document.levelId) return state;

      const incomingById = new Map(action.elements.map(el => [el.id, el]));
      // Determine which layers are being updated (by discipline/tableName)
      const incomingLayerKeys = new Set(action.elements.map(el => `${el.discipline}/${el.tableName}`));

      const next = new Map(state.document.elements);
      // Remove elements from the affected layers that are no longer present
      for (const [id, el] of next) {
        const key = `${el.discipline}/${el.tableName}`;
        if (incomingLayerKeys.has(key) && !incomingById.has(id)) {
          next.delete(id);
        }
      }
      // Add/replace with incoming elements
      for (const el of action.elements) {
        next.set(el.id, el);
      }

      return {
        ...state,
        document: { ...state.document, elements: next },
        documentVersion: state.documentVersion + 1,
        // Don't set lastMutation — this is not a user edit, should not trigger auto-persist
      };
    }

    case 'ADD_LEVEL': {
      if (!state.project) return state;
      const levels = [...state.project.levels, action.level];
      levels.sort((a, b) => a.elevation - b.elevation);
      const floor = { levelId: action.level.id, levelName: action.level.name, layers: [] };
      return pushLevelCommand(state, 'Add level',
        { levels: state.project.levels, levelId: action.level.id, floor: null },
        { levels, levelId: action.level.id, floor });
    }

    case 'REMOVE_LEVEL': {
      if (!state.project || !state.project.levels.some(l => l.id === action.levelId)) return state;
      const levels = state.project.levels.filter(l => l.id !== action.levelId);
      return pushLevelCommand(state, 'Remove level',
        { levels: state.project.levels, levelId: action.levelId, floor: currentFloor(state, action.levelId) },
        { levels, levelId: action.levelId, floor: null });
    }

    case 'RENAME_LEVEL': {
      if (!state.project) return state;
      const levels = state.project.levels.map(l =>
        l.id === action.levelId ? { ...l, name: action.name, elevation: action.elevation } : l
      );
      levels.sort((a, b) => a.elevation - b.elevation);
      return pushLevelCommand(state, 'Rename level',
        { levels: state.project.levels, levelId: action.levelId },
        { levels, levelId: action.levelId });
    }

    default:
      return state;
  }
}

// ─── Level commands (undoable add / remove / rename) ─────────────────────────

/** The level's content as a FloorData; for the open level, from the live document. */
function currentFloor(state: EditorState, levelId: string): import('../types.ts').FloorData | null {
  const floor = state.project?.floors.get(levelId) ?? null;
  const doc = state.document;
  if (!doc || doc.levelId !== levelId) return floor;
  const levelName = state.project?.levels.find(l => l.id === levelId)?.name || levelId;
  const layers: LayerData[] = [];
  for (const [key, els] of groupByLayer([...doc.elements.values()].filter(e => e.tableName !== 'grid'))) {
    const [discipline, tableName] = key.split('/');
    layers.push({ tableName, discipline, geojsonContent: serializeToGeoJson(els), csvRows: new Map(els.map(e => [e.id, e.attrs])) });
  }
  return { levelId, levelName, layers };
}

/** Put the project's levels (and the affected floor) into `snap`'s shape. */
function applyLevelSnapshot(state: EditorState, snap: LevelSnapshot): EditorState {
  if (!state.project) return state;
  const floors = new Map(state.project.floors);
  let next: EditorState = state;
  if (snap.floor === null) {
    floors.delete(snap.levelId);
    next = { ...state, project: { ...state.project, levels: snap.levels, floors } };
    if (state.currentLevel === snap.levelId) {
      // The open level is gone: drop its document (EditorShell must not save
      // it back into the removed folder) and open the first remaining level.
      next = { ...next, document: null, currentLevel: '' };
      const first = snap.levels[0]?.id;
      if (first) next = editorReducer(next, { type: 'SET_LEVEL', levelId: first });
    }
    return next;
  }
  if (snap.floor) floors.set(snap.levelId, snap.floor);
  next = { ...state, project: { ...state.project, levels: snap.levels, floors } };
  // A level that (re)appears is opened, like Add Level does.
  if (snap.floor && state.currentLevel !== snap.levelId) {
    next = editorReducer(next, { type: 'SET_LEVEL', levelId: snap.levelId });
  }
  return next;
}

function pushLevelCommand(state: EditorState, description: string, before: LevelSnapshot, after: LevelSnapshot): EditorState {
  const cmd: EditCommand = { ...createCommand(description, new Map(), new Map()), level: { before, after } };
  return { ...applyLevelSnapshot(state, after), history: pushCommand(state.history, cmd) };
}

function undoLevelCommand(state: EditorState, cmd: EditCommand): EditorState {
  const { before, after } = cmd.level!;
  // Redo must bring back what the level holds now, not what it held when added.
  const redoCmd: EditCommand = after.floor
    ? { ...cmd, level: { before, after: { ...after, floor: currentFloor(state, after.levelId) ?? after.floor } } }
    : cmd;
  const next = applyLevelSnapshot(state, before);
  return {
    ...next,
    history: { undoStack: state.history.undoStack.slice(0, -1), redoStack: [...state.history.redoStack, redoCmd] },
  };
}

function redoLevelCommand(state: EditorState, cmd: EditCommand): EditorState {
  const { before, after } = cmd.level!;
  const undoCmd: EditCommand = before.floor
    ? { ...cmd, level: { before: { ...before, floor: currentFloor(state, before.levelId) ?? before.floor }, after } }
    : cmd;
  const next = applyLevelSnapshot(state, after);
  return {
    ...next,
    history: { undoStack: [...state.history.undoStack, undoCmd], redoStack: state.history.redoStack.slice(0, -1) },
  };
}

/** A module's `autoFillOnPlace` defaults for the next placement of `tableName`. */
function autoFillFor(tableName: string, elements: ReadonlyMap<string, CanonicalElement>): Record<string, string> {
  const mod = getElementModule(tableName);
  if (!mod?.autoFillOnPlace) return {};
  const existing: CanonicalElement[] = [];
  for (const el of elements.values()) if (el.tableName === tableName) existing.push(el);
  return mod.autoFillOnPlace(existing);
}

/**
 * A hosted element (door / window / wall opening) duplicated on its own:
 * keep it on the original host at the projected position, but never on top
 * of the original — then it goes right next to it (side picked by the offset,
 * flipped when the wall is too short).
 */
function slideOnHost(
  clone: CanonicalElement,
  original: CanonicalElement,
  host: CanonicalElement | undefined,
  offset: { dx: number; dy: number },
): CanonicalElement {
  if (!host || (host.geometry !== 'line' && host.geometry !== 'spatial_line')) return clone;
  if (original.geometry !== 'line' || !('position' in original.attrs)) return clone;
  const wall = host as LineElement;
  const width = parseFloat(original.attrs.width ?? '') || Math.hypot(original.end.x - original.start.x, original.end.y - original.start.y);
  const pos = parseFloat(original.attrs.position ?? '') || computeHostedPosition(wall, midpoint(original));
  const len = wall.arc ? arcLength(wall.start, wall.end, wall.arc) : Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const moved = midpoint(original);
  let next = computeHostedPosition(wall, { x: moved.x + offset.dx, y: moved.y + offset.dy });
  if (Math.abs(next - pos) < width) {
    const gap = width + 0.1;
    const side = next >= pos ? 1 : -1;
    next = pos + side * gap;
    if (next + width / 2 > len || next - width / 2 < 0) next = pos - side * gap;
  }
  next = Math.max(width / 2, Math.min(len - width / 2, next));
  const { start, end } = resolveHostedGeometry(wall, next, width);
  return { ...clone, start, end, locationParam: next, attrs: { ...clone.attrs, position: next.toFixed(3) } } as CanonicalElement;
}

function midpoint(el: LineElement): { x: number; y: number } {
  return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
}

function moveElement(el: CanonicalElement, dx: number, dy: number): CanonicalElement {
  switch (el.geometry) {
    case 'line':
      return {
        ...el,
        start: { x: el.start.x + dx, y: el.start.y + dy },
        end: { x: el.end.x + dx, y: el.end.y + dy },
      };
    case 'spatial_line':
      return {
        ...el,
        start: { x: el.start.x + dx, y: el.start.y + dy },
        end: { x: el.end.x + dx, y: el.end.y + dy },
      };
    case 'point': {
      const newPos = { x: el.position.x + dx, y: el.position.y + dy };
      // Sync x/y attrs for tables that persist position via CSV columns (space).
      const attrs = { ...el.attrs };
      if ('x' in attrs) attrs.x = String(newPos.x);
      if ('y' in attrs) attrs.y = String(newPos.y);
      return { ...el, position: newPos, attrs };
    }
    case 'polygon':
      return {
        ...el,
        vertices: el.vertices.map(v => ({ x: v.x + dx, y: v.y + dy })),
        ...(el.holes ? { holes: el.holes.map(h => h.map(v => ({ x: v.x + dx, y: v.y + dy }))) } : {}),
      };
  }
}

/**
 * Check if an element's top_level_id skips levels (not same or adjacent-above).
 * If so, migrate it to globalLayers and return updated ProjectData.
 * Returns null if no migration needed.
 */
function maybeMigrateToGlobal(element: CanonicalElement, state: EditorState): import('../types.ts').ProjectData | null {
  const project = state.project;
  if (!project) return null;

  const topLevelId = element.attrs.top_level_id;
  if (!topLevelId) return null;

  const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
  const currentIdx = sorted.findIndex(l => l.id === state.currentLevel);
  const topIdx = sorted.findIndex(l => l.id === topLevelId);

  // No migration needed: same level, next level up, or unresolvable
  if (currentIdx < 0 || topIdx < 0) return null;
  if (topIdx <= currentIdx + 1) return null;

  // Skips at least one level → migrate to globalLayers
  const globalLayers = [...project.globalLayers];
  const existingIdx = globalLayers.findIndex(
    l => l.tableName === element.tableName && l.discipline === element.discipline
  );

  if (existingIdx >= 0) {
    // Parse existing elements, add the new one, re-serialize SVG
    const existing = globalLayers[existingIdx];
    const existingElements = parseLayer(existing);
    const allElements = [...existingElements, element];
    const newCsvRows = new Map(existing.csvRows);
    newCsvRows.set(element.id, element.attrs);
    globalLayers[existingIdx] = {
      ...existing,
      geojsonContent: serializeToGeoJson(allElements),
      csvRows: newCsvRows,
    };
  } else {
    // Create new global layer
    globalLayers.push({
      tableName: element.tableName,
      discipline: element.discipline,
      geojsonContent: serializeToGeoJson([element]),
      csvRows: new Map([[element.id, element.attrs]]),
    } as LayerData);
  }

  return { ...project, globalLayers };
}

/** Round to mm so resized sizes don't persist float noise. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function applyResize(el: CanonicalElement, changes: Partial<CanonicalElement>): CanonicalElement {
  // Optional attrs merge — callers (e.g. MEP endpoint snap) may need to
  // co-update `from`/`to` along with the geometry change. We don't allow
  // wholesale replacement here, only key-by-key merging.
  const mergedAttrs = 'attrs' in changes && changes.attrs
    ? { ...el.attrs, ...changes.attrs }
    : el.attrs;
  switch (el.geometry) {
    case 'line': {
      const lc = changes as Partial<LineElement>;
      return {
        ...el,
        start: 'start' in lc ? lc.start! : el.start,
        end: 'end' in lc ? lc.end! : el.end,
        strokeWidth: 'strokeWidth' in lc ? lc.strokeWidth! : el.strokeWidth,
        arc: 'arc' in lc ? lc.arc : el.arc,
        attrs: mergedAttrs,
      };
    }
    case 'spatial_line': {
      const sc = changes as Partial<SpatialLineElement>;
      const spEl = el as SpatialLineElement;
      return {
        ...el,
        start: 'start' in sc ? sc.start! : el.start,
        end: 'end' in sc ? sc.end! : el.end,
        startZ: 'startZ' in sc ? sc.startZ! : spEl.startZ,
        endZ: 'endZ' in sc ? sc.endZ! : spEl.endZ,
        strokeWidth: 'strokeWidth' in sc ? sc.strokeWidth! : el.strokeWidth,
        arc: 'arc' in sc ? sc.arc : el.arc,
        attrs: mergedAttrs,
      };
    }
    case 'point': {
      const newW = 'width' in changes ? (changes as Partial<PointElement>).width! : el.width;
      const newH = 'height' in changes ? (changes as Partial<PointElement>).height! : el.height;
      const newPos = 'position' in changes ? (changes as Partial<PointElement>).position! : el.position;
      // Sync size_x/size_y/x/y attrs so property panel + CSV stay in sync with geometry.
      // For CSV-only tables like `space`, x/y *are* the persisted position columns —
      // without this sync the element re-loads at (0,0) after refresh.
      const pointAttrs = { ...el.attrs };
      const [sx, sy] = pointSizeAttrsForTable(el.tableName);
      if ('width' in changes && sx in pointAttrs) pointAttrs[sx] = String(r3(newW));
      if ('height' in changes && sy in pointAttrs) pointAttrs[sy] = String(r3(newH));
      if ('position' in changes && 'x' in pointAttrs) pointAttrs.x = String(newPos.x);
      if ('position' in changes && 'y' in pointAttrs) pointAttrs.y = String(newPos.y);
      return {
        ...el,
        position: newPos,
        width: newW,
        height: newH,
        attrs: pointAttrs,
      };
    }
    case 'polygon':
      return {
        ...el,
        vertices: 'vertices' in changes ? (changes as Partial<PolygonElement>).vertices! : el.vertices,
      };
  }
}
