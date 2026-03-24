import type { EditorState, EditorAction } from './editorTypes.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement } from '../model/elements.ts';
import { emptyHistory, pushCommand, applyUndo, applyRedo, createCommand } from '../model/history.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import { generateId } from '../model/ids.ts';

export const initialState: EditorState = {
  modelName: '',
  project: null,
  grids: [],
  loading: true,

  currentLevel: '',

  viewMode: '2d',
  floor3DMode: 'current',

  visibleLayers: new Set(),
  showGrid: true,

  activeTool: 'select',
  previousTool: 'select',
  activeFilter: null,
  activeDiscipline: null,
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

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.mode };

    case 'SET_FLOOR_3D_MODE':
      return { ...state, floor3DMode: action.mode };

    case 'SET_PROJECT': {
      const { model, project, grids } = action;
      let currentLevel = '';
      let visibleLayers = new Set<string>();
      let activeDiscipline: string | null = null;

      if (project.floors.size > 0) {
        const firstLevel = project.levels.find(l => project.floors.has(l.id));
        if (firstLevel) {
          currentLevel = firstLevel.id;
          const floor = project.floors.get(firstLevel.id);
          if (floor) {
            visibleLayers = new Set(floor.layers.map(l => `${l.discipline}/${l.tableName}`));
            if (floor.layers.length > 0) activeDiscipline = floor.layers[0].discipline;
          }
        }
      } else if (project.levels.length > 0) {
        // New/empty project: auto-select first level so editor is ready to draw
        currentLevel = project.levels[0].id;
      }
      // Always show grids by default
      if (grids.length > 0) visibleLayers.add('reference/grid');

      return { ...state, modelName: model, project, grids, loading: false, currentLevel, visibleLayers, activeDiscipline };
    }

    case 'SET_LOADING':
      return { ...state, loading: action.loading };

    case 'UPDATE_GRIDS':
      return { ...state, grids: action.grids };

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

      return {
        ...state,
        project: { ...state.project, floors },
      };
    }

    case 'SET_LEVEL': {
      const floor = state.project?.floors.get(action.levelId);
      const visibleLayers = floor
        ? new Set(floor.layers.map(l => `${l.discipline}/${l.tableName}`))
        : new Set<string>();
      // Preserve grid visibility across levels
      if (state.visibleLayers.has('reference/grid')) visibleLayers.add('reference/grid');

      let activeDiscipline = state.activeDiscipline;
      if (floor && floor.layers.length > 0) {
        const hasDiscipline = floor.layers.some(l => l.discipline === state.activeDiscipline);
        if (!hasDiscipline) activeDiscipline = floor.layers[0].discipline;
      }

      return {
        ...state,
        currentLevel: action.levelId,
        visibleLayers,
        activeDiscipline,
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

    case 'SET_TOOL':
      return {
        ...state,
        activeTool: action.tool,
        previousTool: state.activeTool,
      };

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
      const next = new Map(state.document.elements);
      // Collect hosted elements that should cascade with moved hosts
      const movedSet = new Set(ids);
      const allIds = [...ids];
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
      const next = new Map(state.document.elements);
      next.set(action.element.id, action.element);
      // Auto-show layer if not yet visible
      const layerKey = `${action.element.discipline}/${action.element.tableName}`;
      const visibleLayers = state.visibleLayers.has(layerKey)
        ? state.visibleLayers
        : new Set([...state.visibleLayers, layerKey]);
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Create element', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: [layerKey] },
        selectedIds: state.drawingTarget ? state.selectedIds : new Set([action.element.id]),
        visibleLayers,
      };
    }

    case 'DELETE_ELEMENTS': {
      if (!state.document) return state;
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const next = new Map(state.document.elements);
      const deletedSet = new Set(action.ids);
      // Delete requested elements
      for (const id of action.ids) {
        const el = next.get(id);
        if (el) {
          before.set(id, el);
          after.set(id, null);
          next.delete(id);
        }
      }
      // Cascade delete hosted elements whose host was deleted
      for (const [id, el] of next) {
        if (el.hostId && deletedSet.has(el.hostId)) {
          before.set(id, el);
          after.set(id, null);
          next.delete(id);
          deletedSet.add(id);
        }
      }
      if (before.size === 0) return state;
      const nextSelected = new Set(state.selectedIds);
      for (const id of deletedSet) nextSelected.delete(id);
      
      return {
        ...state,
        document: { ...state.document, elements: next },
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
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const next = new Map(state.document.elements);
      const existingIds = new Set(next.keys());
      const newIds: string[] = [];
      for (const id of ids) {
        const el = next.get(id);
        if (!el) continue;
        const newId = generateId(el.tableName, existingIds);
        existingIds.add(newId);
        const cloned = { ...moveElement(el, offset.dx, offset.dy), id: newId, attrs: { ...el.attrs, id: newId } };
        next.set(newId, cloned);
        before.set(newId, null);
        after.set(newId, cloned);
        newIds.push(newId);
      }
      if (newIds.length === 0) return state;
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Duplicate elements', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(after) },
        selectedIds: new Set(newIds),
      };
    }

    case 'UPDATE_ATTRS': {
      if (!state.document) return state;
      const el = state.document.elements.get(action.id);
      if (!el) return state;
      const before = new Map<string, CanonicalElement | null>([[action.id, el]]);
      const updated = { ...el, attrs: { ...el.attrs, ...action.attrs } };
      const after = new Map<string, CanonicalElement | null>([[action.id, updated]]);
      const next = new Map(state.document.elements);
      next.set(action.id, updated);
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
      const el = state.document.elements.get(action.id);
      if (!el) return state;
      const resized = applyResize(el, action.changes);
      const next = new Map(state.document.elements);
      next.set(action.id, resized);
      if (action.preview) {
        return { ...state, document: { ...state.document, elements: next } };
      }
      const before = new Map<string, CanonicalElement | null>([[action.id, el]]);
      const after = new Map<string, CanonicalElement | null>([[action.id, resized]]);
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
      return {
        ...state,
        history: pushCommand(state.history, createCommand(action.description, action.before, action.after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: collectMutationKeys(action.before, action.after) }
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

    case 'SET_DRAWING_TARGET':
      return {
        ...state,
        drawingTarget: action.target,
        drawingAttrs: action.target
          ? getDefaultDrawingAttrs(action.target.tableName, state.currentLevel, state.project?.levels)
          : {},
      };

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
    case 'point':
      return {
        ...el,
        position: { x: el.position.x + dx, y: el.position.y + dy },
      };
    case 'polygon':
      return {
        ...el,
        vertices: el.vertices.map(v => ({ x: v.x + dx, y: v.y + dy })),
      };
  }
}

function applyResize(el: CanonicalElement, changes: Partial<CanonicalElement>): CanonicalElement {
  switch (el.geometry) {
    case 'line':
      return {
        ...el,
        start: 'start' in changes ? (changes as Partial<LineElement>).start! : el.start,
        end: 'end' in changes ? (changes as Partial<LineElement>).end! : el.end,
        strokeWidth: 'strokeWidth' in changes ? (changes as Partial<LineElement>).strokeWidth! : el.strokeWidth,
      };
    case 'spatial_line':
      return {
        ...el,
        start: 'start' in changes ? (changes as Partial<SpatialLineElement>).start! : el.start,
        end: 'end' in changes ? (changes as Partial<SpatialLineElement>).end! : el.end,
        strokeWidth: 'strokeWidth' in changes ? (changes as Partial<SpatialLineElement>).strokeWidth! : el.strokeWidth,
      };
    case 'point':
      return {
        ...el,
        position: 'position' in changes ? (changes as Partial<PointElement>).position! : el.position,
        width: 'width' in changes ? (changes as Partial<PointElement>).width! : el.width,
        height: 'height' in changes ? (changes as Partial<PointElement>).height! : el.height,
      };
    case 'polygon':
      return {
        ...el,
        vertices: 'vertices' in changes ? (changes as Partial<PolygonElement>).vertices! : el.vertices,
      };
  }
}
