import type { EditorState, EditorAction } from './editorTypes.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement } from '../model/elements.ts';
import { emptyHistory, pushCommand, applyUndo, applyRedo, createCommand } from '../model/history.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import { generateId, toElementId, toSelectionId } from '../model/ids.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import { isVerticalSpanTable } from '../model/tableRegistry.ts';
import { collectMepBranch, isMepLineTable } from '../model/mepTopology.ts';
import { bondEndpoints } from '../model/bondEndpoints.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { serializeToGeoJson } from '../model/serialize.ts';
import { parseLayer } from '../model/parse.ts';
import type { LayerData } from '../types.ts';
import { getElementModule } from '../elements/registry.ts';
import { portRefTargetsHost } from '../utils/portRef.ts';

/** Tables hidden by default (user can toggle on via layer panel). */
const HIDDEN_BY_DEFAULT = new Set(['ceiling']);

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
  showMinimap: true,

  activeTool: 'select',
  previousTool: 'select',
  activeFilter: null,
  activeDiscipline: null,
  showArchContext: true,
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
  'UPDATE_ATTRS', 'COMMIT_PREVIEW', 'DUPLICATE_ELEMENTS', 'APPLY_PATCH',
  'UNDO', 'REDO', 'ADD_LEVEL', 'REMOVE_LEVEL', 'RENAME_LEVEL',
]);

/** Tools allowed in readonly mode — everything else is blocked. */
const READONLY_TOOLS: Set<string> = new Set(['select', 'orbit', 'pan', 'zoom']);

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  // Readonly guard: silently reject all mutation actions
  if (state.readonly && MUTATION_ACTIONS.has(action.type)) return state;

  // Readonly guard: only allow view/navigation tools
  if (state.readonly && action.type === 'SET_TOOL' && !READONLY_TOOLS.has(action.tool)) return state;

  switch (action.type) {
    case 'SET_VIEW_MODE': {
      let tool = state.activeTool;
      // Auto-switch between select ↔ orbit when toggling 2D/3D
      if (action.mode === '3d' && tool === 'select') tool = 'orbit';
      if (action.mode === '2d' && tool === 'orbit') tool = 'select';
      return { ...state, viewMode: action.mode, activeTool: tool };
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
        const firstLevel = project.levels.find(l => project.floors.has(l.id));
        if (firstLevel) {
          currentLevel = firstLevel.id;
          const floor = project.floors.get(firstLevel.id);
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

      return { ...state, modelName: model, project, grids, loading: false, currentLevel, visibleLayers, activeDiscipline };
    }

    case 'SET_LOADING':
      return { ...state, loading: action.loading };

    case 'UPDATE_GRIDS':
      return { ...state, grids: action.grids };

    case 'UPDATE_MEP_SYSTEMS': {
      if (!state.project) return state;
      return { ...state, project: { ...state.project, mepSystems: action.mepSystems } };
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
      return { ...state, document: action.document, history: emptyHistory, documentVersion: 0, lastMutation: null };

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
      for (const rawId of rawIds) {
        const el = next.get(rawId);
        if (!el) continue;
        const newId = generateId(el.tableName, existingIds);
        existingIds.add(newId);
        const cloned = { ...moveElement(el, offset.dx, offset.dy), id: newId, attrs: { ...el.attrs, id: newId } };
        next.set(newId, cloned);
        before.set(newId, null);
        after.set(newId, cloned);
        // Selection IDs keep the level prefix
        newSelectionIds.push(state.currentLevel ? toSelectionId(state.currentLevel, newId) : newId);
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

      // Sync size_x/size_y attrs → PointElement width/height
      if (updated.geometry === 'point') {
        const pt = updated as PointElement;
        if ('size_x' in action.attrs) pt.width = parseFloat(action.attrs.size_x) || pt.width;
        if ('size_y' in action.attrs) pt.height = parseFloat(action.attrs.size_y) || pt.height;
      }

      // Sync thickness attr → LineElement/SpatialLineElement strokeWidth.
      // Without this, wall/beam/duct geometry stays at the old thickness even
      // though the CSV row shows the new value.
      if ((updated.geometry === 'line' || updated.geometry === 'spatial_line') && 'thickness' in action.attrs) {
        const t = parseFloat(action.attrs.thickness);
        if (Number.isFinite(t) && t > 0) (updated as LineElement).strokeWidth = t;
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

    case 'RESIZE_ELEMENT': {
      if (!state.document) return state;
      const rawId = toElementId(action.id);
      const el = state.document.elements.get(rawId);
      if (!el) return state;
      const resized = applyResize(el, action.changes);
      const next = new Map(state.document.elements);
      next.set(rawId, resized);

      // Re-resolve hosted elements when their host wall is resized
      if (resized.geometry === 'line' || resized.geometry === 'spatial_line') {
        const wall = resized as LineElement;
        for (const [id, hosted] of next) {
          if (hosted.hostId === rawId && hosted.geometry === 'line' && hosted.locationParam != null) {
            const width = parseFloat(hosted.attrs.width ?? '0.9');
            const { start, end } = resolveHostedGeometry(wall, hosted.locationParam, width);
            next.set(id, { ...hosted, start, end } as LineElement);
          }
        }
      }

      // Topology cascade (reverse of MOVE_ELEMENTS' host case):
      // When a pipe/duct/conduit/cable_tray's endpoint moves, drag the
      // connected mep_node along with it AND every other pipe sharing that
      // node. Equipment/terminal hosts are intentionally NOT dragged this way
      // (they're authored, not derived); only passive mep_node hosts cascade.
      const partialMoved = new Set<string>();
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
      if (!state.document || state.history.undoStack.length === 0) return state;
      const cmd = state.history.undoStack[state.history.undoStack.length - 1];
      const result = applyUndo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
        document: { ...state.document, elements: result.elements },
        history: result.history,
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(cmd.before, cmd.after) }
      };
    }

    case 'REDO': {
      if (!state.document || state.history.redoStack.length === 0) return state;
      const cmd = state.history.redoStack[state.history.redoStack.length - 1];
      const result = applyRedo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
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
        attrs = getDefaultDrawingAttrs(action.target.tableName, state.currentLevel, state.project?.levels);
        // Modules opt in to sequential defaults / other tool-activation
        // auto-fills via `autoFillOnPlace`. Counts existing elements of this
        // table so each placement bumps the next default value.
        const mod = getElementModule(action.target.tableName);
        if (mod?.autoFillOnPlace && state.document) {
          let count = 0;
          for (const el of state.document.elements.values()) {
            if (el.tableName === action.target.tableName) count++;
          }
          Object.assign(attrs, mod.autoFillOnPlace(count));
        }
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
      const floors = new Map(state.project.floors);
      floors.set(action.level.id, { levelId: action.level.id, levelName: action.level.name, layers: [] });
      return {
        ...state,
        project: { ...state.project, levels, floors },
        currentLevel: action.level.id,
        visibleLayers: new Set<string>(),
        selectedIds: new Set(),
        hoveredId: null,
      };
    }

    case 'REMOVE_LEVEL': {
      if (!state.project) return state;
      const levels = state.project.levels.filter(l => l.id !== action.levelId);
      const floors = new Map(state.project.floors);
      floors.delete(action.levelId);
      const newLevel = levels.length > 0 ? levels[0].id : '';
      return {
        ...state,
        project: { ...state.project, levels, floors },
        currentLevel: state.currentLevel === action.levelId ? newLevel : state.currentLevel,
        selectedIds: new Set(),
        hoveredId: null,
      };
    }

    case 'RENAME_LEVEL': {
      if (!state.project) return state;
      const levels = state.project.levels.map(l =>
        l.id === action.levelId ? { ...l, name: action.name, elevation: action.elevation } : l
      );
      levels.sort((a, b) => a.elevation - b.elevation);
      return { ...state, project: { ...state.project, levels } };
    }

    default:
      return state;
  }
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
      return {
        ...el,
        start: 'start' in sc ? sc.start! : el.start,
        end: 'end' in sc ? sc.end! : el.end,
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
      if ('width' in changes && 'size_x' in pointAttrs) pointAttrs.size_x = String(newW);
      if ('height' in changes && 'size_y' in pointAttrs) pointAttrs.size_y = String(newH);
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
