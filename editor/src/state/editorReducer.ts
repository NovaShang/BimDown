import type { EditorState, EditorAction } from './editorTypes.ts';

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
        return { ...state, selectedIds: next };
      }
      return { ...state, selectedIds: new Set(action.ids) };
    }

    case 'CLEAR_SELECTION':
      return { ...state, selectedIds: new Set(), activeFilter: null };

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

    default:
      return state;
  }
}
