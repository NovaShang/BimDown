import type { ProjectData, GridData, FloorData, LayerData } from '../types.ts';
import type { DocumentState } from '../model/document.ts';
import type { CanonicalElement } from '../model/elements.ts';
import type { HistoryState } from '../model/history.ts';

export type Tool = 'select' | 'pan' | 'zoom' | 'draw_line' | 'draw_point' | 'draw_polygon';

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

export interface EditorState {
  project: ProjectData | null;
  grids: GridData[];
  loading: boolean;

  currentLevel: string;

  visibleLayers: Set<string>;
  showGrid: boolean;

  activeTool: Tool;
  previousTool: Tool;
  activeFilter: string | null;
  activeDiscipline: string | null;
  spaceHeld: boolean;

  transform: ViewTransform;
  baseViewBox: { x: number; y: number; w: number; h: number } | null;

  selectedIds: Set<string>;
  hoveredId: string | null;

  marquee: { x1: number; y1: number; x2: number; y2: number } | null;

  expandedDisciplines: Set<string>;

  // Document model (editing)
  document: DocumentState | null;
  history: HistoryState;
  editMode: boolean;
  drawingTarget: { tableName: string; discipline: string } | null;
  drawingState: DrawingState | null;
  documentVersion: number;  // bumped on every mutation, triggers auto-persist
}

export interface DrawingState {
  points: { x: number; y: number }[];  // placed points so far
  cursor: { x: number; y: number } | null;  // current mouse position in SVG coords
}

export type EditorAction =
  | { type: 'SET_PROJECT'; project: ProjectData; grids: GridData[] }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_LEVEL'; levelId: string }
  | { type: 'TOGGLE_LAYER'; key: string }
  | { type: 'SET_VISIBLE_LAYERS'; keys: Set<string> }
  | { type: 'TOGGLE_GRID' }
  | { type: 'SET_TOOL'; tool: Tool }
  | { type: 'SET_SPACE_HELD'; held: boolean }
  | { type: 'SET_FILTER'; filter: string | null }
  | { type: 'SET_DISCIPLINE'; discipline: string | null }
  | { type: 'SET_TRANSFORM'; transform: ViewTransform }
  | { type: 'ZOOM_TO_FIT' }
  | { type: 'ZOOM_TO_PERCENT'; percent: number }
  | { type: 'ZOOM_BY'; delta: number; centerX?: number; centerY?: number }
  | { type: 'SET_BASE_VIEWBOX'; viewBox: { x: number; y: number; w: number; h: number } }
  | { type: 'SELECT'; ids: string[]; additive?: boolean }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_HOVER'; id: string | null }
  | { type: 'SET_MARQUEE'; marquee: { x1: number; y1: number; x2: number; y2: number } | null }
  | { type: 'TOGGLE_DISCIPLINE_EXPAND'; discipline: string }
  // Document editing actions
  | { type: 'INIT_DOCUMENT'; document: DocumentState }
  | { type: 'MOVE_ELEMENTS'; ids: string[]; dx: number; dy: number; preview?: boolean }
  | { type: 'CREATE_ELEMENT'; element: CanonicalElement }
  | { type: 'DELETE_ELEMENTS'; ids: string[] }
  | { type: 'UPDATE_ATTRS'; id: string; attrs: Record<string, string> }
  | { type: 'RESIZE_ELEMENT'; id: string; changes: Partial<CanonicalElement>; preview?: boolean }
  | { type: 'COMMIT_PREVIEW'; description: string; before: Map<string, CanonicalElement | null>; after: Map<string, CanonicalElement | null> }
  | { type: 'SET_EDIT_MODE'; active: boolean }
  | { type: 'SET_DRAWING_STATE'; state: DrawingState | null }
  | { type: 'SET_DRAWING_TARGET'; target: { tableName: string; discipline: string } | null }
  | { type: 'RELOAD_ELEMENTS'; elements: CanonicalElement[] }
  | { type: 'UNDO' }
  | { type: 'REDO' };

export interface ProcessedLayer {
  key: string;
  tableName: string;
  discipline: string;
  html: string;
}

export interface LayerGroup {
  discipline: string;
  layers: LayerData[];
}

export function getFloorData(state: EditorState): FloorData | undefined {
  return state.project?.floors.get(state.currentLevel);
}
