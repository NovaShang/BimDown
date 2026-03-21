import type { ProjectData, GridData, FloorData, LayerData } from '../types.ts';

export type Tool = 'select' | 'pan' | 'zoom';

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
  | { type: 'TOGGLE_DISCIPLINE_EXPAND'; discipline: string };

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
