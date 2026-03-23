import type { EditorAction, ViewTransform } from '../state/editorTypes.ts';
import type { DocumentState } from '../model/document.ts';
import type { ProjectData, GridData } from '../types.ts';
import type { SnapResult } from '../utils/snap.ts';

// Transform actions are Canvas-local (not in EditorAction), but tools still dispatch them
export type TransformAction =
  | { type: 'SET_TRANSFORM'; transform: ViewTransform }
  | { type: 'ZOOM_BY'; delta: number; centerX?: number; centerY?: number }
  | { type: 'ZOOM_TO_FIT' }
  | { type: 'ZOOM_TO_PERCENT'; percent: number }
  | { type: 'ZOOM_TO_BBOX'; minX: number; minY: number; maxX: number; maxY: number };

type ToolDispatchAction = EditorAction | TransformAction;

export interface ToolContext {
  dispatch: React.Dispatch<ToolDispatchAction>;
  svgRef: React.RefObject<SVGSVGElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Current editor state snapshot */
  getState: () => ToolStateSnapshot;
  /** Convert screen coords to SVG coords */
  screenToSvg: (clientX: number, clientY: number) => { x: number; y: number } | null;
  /** Find element ID from a DOM event target */
  findElementId: (target: EventTarget | null) => string | null;
  /** Set active snap result for visual feedback */
  setSnap: (snap: SnapResult | null) => void;
  /** Optional: resolve marquee selection in 3D (projects elements to screen space).
   *  If not provided, falls back to SVG DOM-based marquee. */
  resolveMarquee?: (rect: { x: number; y: number; w: number; h: number }, containerRect: DOMRect) => string[];
}

export interface ToolStateSnapshot {
  transform: { x: number; y: number; scale: number };
  selectedIds: Set<string>;
  hoveredId: string | null;
  drawingTarget: { tableName: string; discipline: string } | null;
  drawingAttrs: Record<string, string>;
  drawingState: { points: { x: number; y: number }[]; cursor: { x: number; y: number } | null } | null;
  document: DocumentState | null;
  project: ProjectData | null;
  grids: readonly GridData[];
  activeDiscipline: string | null;
}

export interface ToolHandler {
  cursor: string;
  onPointerDown?(ctx: ToolContext, e: React.PointerEvent): void;
  onPointerMove?(ctx: ToolContext, e: React.PointerEvent): void;
  onPointerUp?(ctx: ToolContext, e: React.PointerEvent): void;
}
