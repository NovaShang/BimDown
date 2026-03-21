import type { EditorAction, ViewTransform } from '../state/editorTypes.ts';
import type { DocumentState } from '../model/document.ts';

// Transform actions are Canvas-local (not in EditorAction), but tools still dispatch them
type TransformAction =
  | { type: 'SET_TRANSFORM'; transform: ViewTransform }
  | { type: 'ZOOM_BY'; delta: number; centerX?: number; centerY?: number }
  | { type: 'ZOOM_TO_FIT' }
  | { type: 'ZOOM_TO_PERCENT'; percent: number };

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
}

export interface ToolStateSnapshot {
  transform: { x: number; y: number; scale: number };
  selectedIds: Set<string>;
  hoveredId: string | null;
  drawingTarget: { tableName: string; discipline: string } | null;
  drawingState: { points: { x: number; y: number }[]; cursor: { x: number; y: number } | null } | null;
  document: DocumentState | null;
}

export interface ToolHandler {
  cursor: string;
  onPointerDown?(ctx: ToolContext, e: React.PointerEvent): void;
  onPointerMove?(ctx: ToolContext, e: React.PointerEvent): void;
  onPointerUp?(ctx: ToolContext, e: React.PointerEvent): void;
}
