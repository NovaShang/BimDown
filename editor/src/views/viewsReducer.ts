import type { EditorState } from '../state/editorTypes.ts';
import type { ViewsAction } from './viewTypes.ts';

const VIEW_ACTIONS = new Set<string>([
  'OPEN_VIEW', 'TOGGLE_VIEW_PANE_MAX', 'SET_SECTION_BOX', 'SET_PLAN_CUT',
  'SET_ABOVE_CUT_STYLE', 'TOGGLE_RCP', 'UPDATE_SECTIONS',
]);

export function isViewsAction(action: { type: string }): action is ViewsAction {
  return VIEW_ACTIONS.has(action.type);
}

/** View-state slice of the editor reducer (elevations, sections, section box, plan view range). */
export function viewsReducer(state: EditorState, action: ViewsAction): EditorState {
  const views = state.views;
  switch (action.type) {
    case 'OPEN_VIEW':
      return { ...state, views: { ...views, open: action.view, paneMaximized: action.view ? views.paneMaximized : false } };
    case 'TOGGLE_VIEW_PANE_MAX':
      return { ...state, views: { ...views, paneMaximized: !views.paneMaximized } };
    case 'SET_SECTION_BOX':
      return {
        ...state,
        views: {
          ...views,
          sectionBox: {
            enabled: action.enabled ?? views.sectionBox.enabled,
            bounds: action.bounds !== undefined ? action.bounds : views.sectionBox.bounds,
          },
        },
      };
    case 'SET_PLAN_CUT':
      return { ...state, views: { ...views, planCut: { ...views.planCut, [action.levelId]: action.height } } };
    case 'SET_ABOVE_CUT_STYLE':
      return { ...state, views: { ...views, aboveCut: action.style } };
    case 'TOGGLE_RCP':
      return { ...state, views: { ...views, rcp: !views.rcp } };
    case 'UPDATE_SECTIONS': {
      if (!state.project) return state;
      // Close the pane if its section was deleted.
      const open = views.open?.kind === 'section' && !action.sections.some(s => s.id === (views.open as { id: string }).id)
        ? null : views.open;
      if (action.persist && state.readonly) return state;
      const sectionsSaveSeq = views.sectionsSaveSeq + (action.persist ? 1 : 0);
      return { ...state, project: { ...state.project, sections: action.sections }, views: { ...views, open, sectionsSaveSeq } };
    }
  }
}
