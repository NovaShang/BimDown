import { useEffect } from 'react';
import type { EditorState, EditorAction, Tool } from '../state/editorTypes.ts';
import { toSelectionId } from '../model/ids.ts';
import { DRAW_TOOL_SHORTCUTS } from '../components/FloatingToolbar.tsx';
import { TABLE_REGISTRY } from '../model/tableRegistry.ts';
import { placementTypeForTable } from '../model/elements.ts';

const PLACEMENT_TO_TOOL: Record<string, Tool> = {
  hosted: 'draw_hosted', free_line: 'draw_line', spatial_line: 'draw_line',
  free_point: 'draw_point', free_polygon: 'draw_polygon', grid: 'draw_grid',
};

interface UseCanvasKeyboardOptions {
  globalDispatch: React.Dispatch<EditorAction>;
  stateRef: React.MutableRefObject<EditorState>;
  applyZoomBy: (delta: number) => void;
  applyZoomToFit: () => void;
  applyZoomToPercent: (pct: number) => void;
  activeDiscipline: string | null;
}

export function useCanvasKeyboard({
  globalDispatch, stateRef, applyZoomBy, applyZoomToFit, applyZoomToPercent, activeDiscipline,
}: UseCanvasKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'v': case 'V':
          if (!e.ctrlKey && !e.metaKey) globalDispatch({ type: 'SET_TOOL', tool: 'select' });
          break;
        case 'h': case 'H':
          if (!e.ctrlKey && !e.metaKey) globalDispatch({ type: 'SET_TOOL', tool: 'pan' });
          break;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) {
              globalDispatch({ type: 'REDO' });
            } else {
              globalDispatch({ type: 'UNDO' });
            }
          } else {
            globalDispatch({ type: 'SET_TOOL', tool: 'zoom' });
          }
          break;
        case 'y': case 'Y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            globalDispatch({ type: 'REDO' });
          }
          break;
        case 'g': case 'G':
          if (!e.ctrlKey && !e.metaKey && activeDiscipline === 'reference') {
            globalDispatch({ type: 'SET_TOOL', tool: 'draw_grid' });
            globalDispatch({ type: 'SET_DRAWING_TARGET', target: null });
            globalDispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          }
          break;
        case 'Delete': case 'Backspace':
          if (stateRef.current.selectedIds.size > 0) {
            globalDispatch({ type: 'DELETE_ELEMENTS', ids: Array.from(stateRef.current.selectedIds) });
          }
          break;
        case ' ':
          e.preventDefault();
          globalDispatch({ type: 'SET_SPACE_HELD', held: true });
          break;
        case 'Escape':
          if (stateRef.current.activeTool === 'relocate' || stateRef.current.activeTool === 'relocate_hosted' || stateRef.current.activeTool === 'rotate') {
            globalDispatch({ type: 'SET_TOOL', tool: 'select' });
            globalDispatch({ type: 'SET_DRAWING_STATE', state: null });
            globalDispatch({ type: 'SET_DRAWING_TARGET', target: null });
          } else if (stateRef.current.drawingState?.points.length) {
            globalDispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          } else if (stateRef.current.activeTool.startsWith('draw_')) {
            globalDispatch({ type: 'SET_TOOL', tool: 'select' });
            globalDispatch({ type: 'SET_DRAWING_STATE', state: null });
            globalDispatch({ type: 'SET_DRAWING_TARGET', target: null });
          } else {
            globalDispatch({ type: 'CLEAR_SELECTION' });
          }
          break;
        case '=': case '+':
          applyZoomBy(1.2);
          break;
        case '-': case '_':
          applyZoomBy(1 / 1.2);
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            applyZoomToFit();
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            applyZoomToPercent(100);
          }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const allIds: string[] = [];
            const s = stateRef.current;
            const floor = s.project?.floors.get(s.currentLevel);
            if (floor) {
              for (const layer of floor.layers) {
                if (s.visibleLayers.has(`${layer.discipline}/${layer.tableName}`)) {
                  for (const id of layer.csvRows.keys()) {
                    allIds.push(s.currentLevel ? toSelectionId(s.currentLevel, id) : id);
                  }
                }
              }
            }
            globalDispatch({ type: 'SELECT', ids: allIds });
          }
          break;
      }

      // Drawing tool shortcuts (W, D, N, C, R, F, T, E, P, U)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tableName = DRAW_TOOL_SHORTCUTS[e.key.toUpperCase()];
        if (tableName) {
          const def = TABLE_REGISTRY[tableName];
          if (def && def.discipline === activeDiscipline) {
            const tool = PLACEMENT_TO_TOOL[placementTypeForTable(tableName)];
            if (tool) {
              globalDispatch({ type: 'SET_TOOL', tool });
              globalDispatch({ type: 'SET_DRAWING_TARGET', target: { tableName, discipline: def.discipline } });
              globalDispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
            }
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        globalDispatch({ type: 'SET_SPACE_HELD', held: false });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [globalDispatch, applyZoomBy, applyZoomToFit, applyZoomToPercent, activeDiscipline, stateRef]);
}
