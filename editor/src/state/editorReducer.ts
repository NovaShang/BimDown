import type { EditorState, EditorAction } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { emptyHistory, pushCommand, applyUndo, applyRedo, createCommand } from '../model/history.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';

export const initialState: EditorState = {
  project: null,
  grids: [],
  loading: true,

  currentLevel: '',

  viewMode: '2d',

  visibleLayers: new Set(),
  showGrid: true,

  activeTool: 'select',
  previousTool: 'select',
  activeFilter: null,
  activeDiscipline: null,
  spaceHeld: false,

  baseViewBox: null,

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

    case 'SET_PROJECT': {
      const { project, grids } = action;
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
      }

      return { ...state, project, grids, loading: false, currentLevel, visibleLayers, activeDiscipline };
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
      if (action.levelId === '__all__') {
        // All Floors mode: collect visible layers from all floors
        const allLayers = new Set<string>();
        if (state.project) {
          for (const floor of state.project.floors.values()) {
            for (const l of floor.layers) allLayers.add(`${l.discipline}/${l.tableName}`);
          }
        }
        return {
          ...state,
          currentLevel: '__all__',
          visibleLayers: allLayers,
          activeDiscipline: state.activeDiscipline ?? 'architectural',
          selectedIds: new Set(),
          hoveredId: null,
          activeFilter: null,
          baseViewBox: null,
        };
      }

      const floor = state.project?.floors.get(action.levelId);
      const visibleLayers = floor
        ? new Set(floor.layers.map(l => `${l.discipline}/${l.tableName}`))
        : new Set<string>();

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
        baseViewBox: null,
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

    case 'SET_BASE_VIEWBOX':
      return { ...state, baseViewBox: action.viewBox };

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
      let changed = false;
      for (const id of ids) {
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
      for (const id of ids) {
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
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Create element', before, after)),
        documentVersion: state.documentVersion + 1,
        lastMutation: { version: state.documentVersion + 1, keys: [`${action.element.discipline}/${action.element.tableName}`] },
        selectedIds: state.drawingTarget ? state.selectedIds : new Set([action.element.id]),
      };
    }

    case 'DELETE_ELEMENTS': {
      if (!state.document) return state;
      const before = new Map<string, CanonicalElement | null>();
      const after = new Map<string, CanonicalElement | null>();
      const next = new Map(state.document.elements);
      for (const id of action.ids) {
        const el = next.get(id);
        if (el) {
          before.set(id, el);
          after.set(id, null);
          next.delete(id);
        }
      }
      if (before.size === 0) return state;
      const nextSelected = new Set(state.selectedIds);
      for (const id of action.ids) nextSelected.delete(id);
      
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
      const resized = { ...el, ...action.changes, id: el.id, tableName: el.tableName, discipline: el.discipline, attrs: el.attrs } as CanonicalElement;
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
        drawingAttrs: action.target ? getDefaultDrawingAttrs(action.target.tableName) : {},
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
