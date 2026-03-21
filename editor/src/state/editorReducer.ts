import type { EditorState, EditorAction } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { emptyHistory, pushCommand, applyUndo, applyRedo, createCommand } from '../model/history.ts';

export const initialState: EditorState = {
  project: null,
  grids: [],
  loading: true,

  currentLevel: '',

  visibleLayers: new Set(),
  showGrid: true,

  activeTool: 'select',
  previousTool: 'select',
  activeFilter: null,
  activeDiscipline: null,
  spaceHeld: false,

  transform: { x: 0, y: 0, scale: 1 },
  baseViewBox: null,

  selectedIds: new Set(),
  hoveredId: null,

  marquee: null,

  expandedDisciplines: new Set(['architectural', 'structural', 'hvac', 'plumbing', 'electrical']),

  document: null,
  history: emptyHistory,
  editMode: false,
  drawingTarget: null,
  drawingState: null,
  documentVersion: 0,
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'SET_PROJECT': {
      const { project, grids } = action;
      let currentLevel = '';
      let visibleLayers = new Set<string>();

      if (project.floors.size > 0) {
        const firstLevel = project.levels.find(l => project.floors.has(l.id));
        if (firstLevel) {
          currentLevel = firstLevel.id;
          const floor = project.floors.get(firstLevel.id);
          if (floor) {
            visibleLayers = new Set(floor.layers.map(l => `${l.discipline}/${l.tableName}`));
          }
        }
      }

      return { ...state, project, grids, loading: false, currentLevel, visibleLayers };
    }

    case 'SET_LOADING':
      return { ...state, loading: action.loading };

    case 'SET_LEVEL': {
      const floor = state.project?.floors.get(action.levelId);
      const visibleLayers = floor
        ? new Set(floor.layers.map(l => `${l.discipline}/${l.tableName}`))
        : new Set<string>();
      return {
        ...state,
        currentLevel: action.levelId,
        visibleLayers,
        selectedIds: new Set(),
        hoveredId: null,
        activeFilter: null,
        transform: { x: 0, y: 0, scale: 1 },
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

    case 'SET_TRANSFORM':
      return { ...state, transform: action.transform };

    case 'SET_BASE_VIEWBOX':
      return { ...state, baseViewBox: action.viewBox };

    case 'ZOOM_BY': {
      const { delta, centerX, centerY } = action;
      const newScale = Math.min(Math.max(state.transform.scale * delta, 0.05), 100);
      if (centerX !== undefined && centerY !== undefined) {
        const ratio = newScale / state.transform.scale;
        return {
          ...state,
          transform: {
            scale: newScale,
            x: centerX - (centerX - state.transform.x) * ratio,
            y: centerY - (centerY - state.transform.y) * ratio,
          },
        };
      }
      return { ...state, transform: { ...state.transform, scale: newScale } };
    }

    case 'ZOOM_TO_FIT':
      return {
        ...state,
        transform: { x: 0, y: 0, scale: 1 },
      };

    case 'ZOOM_TO_PERCENT':
      return {
        ...state,
        transform: { ...state.transform, scale: action.percent / 100 },
      };

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

    case 'TOGGLE_DISCIPLINE_EXPAND': {
      const next = new Set(state.expandedDisciplines);
      if (next.has(action.discipline)) next.delete(action.discipline);
      else next.add(action.discipline);
      return { ...state, expandedDisciplines: next };
    }

    // --- Document editing actions ---

    case 'INIT_DOCUMENT':
      return { ...state, document: action.document, history: emptyHistory };

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
        before.set(id, state.document.elements.get(id) ?? null);
        after.set(id, next.get(id) ?? null);
      }
      return {
        ...state,
        document: { ...state.document, elements: next },
        history: pushCommand(state.history, createCommand('Move elements', before, after)),
        documentVersion: state.documentVersion + 1,
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
        selectedIds: new Set([action.element.id]),
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
      };
    }

    case 'COMMIT_PREVIEW': {
      if (!state.document) return state;
      return {
        ...state,
        history: pushCommand(state.history, createCommand(action.description, action.before, action.after)),
        documentVersion: state.documentVersion + 1,
      };
    }

    case 'UNDO': {
      if (!state.document) return state;
      const result = applyUndo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
        document: { ...state.document, elements: result.elements },
        history: result.history,
        documentVersion: state.documentVersion + 1,
      };
    }

    case 'REDO': {
      if (!state.document) return state;
      const result = applyRedo(state.history, state.document.elements);
      if (!result) return state;
      return {
        ...state,
        document: { ...state.document, elements: result.elements },
        history: result.history,
        documentVersion: state.documentVersion + 1,
      };
    }

    case 'SET_EDIT_MODE':
      return { ...state, editMode: action.active };

    case 'SET_DRAWING_STATE':
      return { ...state, drawingState: action.state };

    case 'SET_DRAWING_TARGET':
      return { ...state, drawingTarget: action.target };

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
