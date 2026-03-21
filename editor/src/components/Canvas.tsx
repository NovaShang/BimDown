import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer } from '../state/editorTypes.ts';
import { LAYER_STYLES } from '../types.ts';
import { getToolHandler } from '../tools/registry.ts';
import type { ToolContext, ToolStateSnapshot } from '../tools/types.ts';
import SelectionOverlay from './SelectionOverlay.tsx';
import MarqueeSelection from './MarqueeSelection.tsx';
import DrawingOverlay from './DrawingOverlay.tsx';
import ResizeHandles from './ResizeHandles.tsx';
import Minimap from './Minimap.tsx';

interface CanvasProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number } | null;
  gridSvg?: string;
  activeFilter: string | null;
}

export default function Canvas({ layers, viewBox, gridSvg, activeFilter }: CanvasProps) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Middle-mouse panning (works across all tools)
  const middlePanning = useRef(false);
  const middleLastPos = useRef({ x: 0, y: 0 });

  const { transform, activeTool, hoveredId, selectedIds } = state;

  // Stable ref for current state (tools read via getState())
  const stateRef = useRef(state);
  stateRef.current = state;

  const findElementId = useCallback((target: EventTarget | null): string | null => {
    let el = target as Element | null;
    while (el && el !== svgRef.current) {
      const id = el.getAttribute('data-id') || el.getAttribute('id');
      if (id && /^[a-z]+-\d+$/i.test(id)) return id;
      el = el.parentElement;
    }
    return null;
  }, []);

  const screenToSvg = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: -svgPt.y };
  }, []);

  const toolCtx = useMemo<ToolContext>(() => ({
    dispatch,
    svgRef,
    containerRef,
    getState: (): ToolStateSnapshot => {
      const s = stateRef.current;
      return {
        transform: s.transform,
        selectedIds: s.selectedIds,
        hoveredId: s.hoveredId,
        drawingTarget: s.drawingTarget,
        drawingState: s.drawingState,
        document: s.document,
      };
    },
    screenToSvg,
    findElementId,
  }), [dispatch, screenToSvg, findElementId]);

  // Hover highlight — add/remove CSS class on hovered elements
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll('.hover-highlight').forEach(el => el.classList.remove('hover-highlight'));
    if (hoveredId) {
      svg.querySelectorAll(`[data-id="${hoveredId}"]`).forEach(el => el.classList.add('hover-highlight'));
    }
  }, [hoveredId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'v': case 'V':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'select' });
          break;
        case 'h': case 'H':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'pan' });
          break;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) {
              dispatch({ type: 'REDO' });
            } else {
              dispatch({ type: 'UNDO' });
            }
          } else {
            dispatch({ type: 'SET_TOOL', tool: 'zoom' });
          }
          break;
        case 'y': case 'Y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            dispatch({ type: 'REDO' });
          }
          break;
        case 'Delete': case 'Backspace':
          if (stateRef.current.selectedIds.size > 0) {
            dispatch({ type: 'DELETE_ELEMENTS', ids: Array.from(stateRef.current.selectedIds) });
          }
          break;
        case ' ':
          e.preventDefault();
          dispatch({ type: 'SET_SPACE_HELD', held: true });
          break;
        case 'Escape':
          if (stateRef.current.drawingState?.points.length) {
            // Cancel drawing in progress
            dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          } else if (stateRef.current.activeTool.startsWith('draw_')) {
            // Exit drawing tool back to select
            dispatch({ type: 'SET_TOOL', tool: 'select' });
            dispatch({ type: 'SET_DRAWING_STATE', state: null });
            dispatch({ type: 'SET_DRAWING_TARGET', target: null });
          } else {
            dispatch({ type: 'CLEAR_SELECTION' });
          }
          break;
        case '=': case '+':
          dispatch({ type: 'ZOOM_BY', delta: 1.2 });
          break;
        case '-': case '_':
          dispatch({ type: 'ZOOM_BY', delta: 1 / 1.2 });
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            dispatch({ type: 'ZOOM_TO_FIT' });
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            dispatch({ type: 'ZOOM_TO_PERCENT', percent: 100 });
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
                    allIds.push(id);
                  }
                }
              }
            }
            dispatch({ type: 'SELECT', ids: allIds });
          }
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        dispatch({ type: 'SET_SPACE_HELD', held: false });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [dispatch]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dispatch({
      type: 'ZOOM_BY',
      delta,
      centerX: e.clientX - rect.left,
      centerY: e.clientY - rect.top,
    });
  }, [dispatch]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Middle mouse always pans regardless of tool
    if (e.button === 1) {
      middlePanning.current = true;
      middleLastPos.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }

    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerDown?.(toolCtx, e);
  }, [toolCtx]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (middlePanning.current) {
      const dx = e.clientX - middleLastPos.current.x;
      const dy = e.clientY - middleLastPos.current.y;
      middleLastPos.current = { x: e.clientX, y: e.clientY };
      const t = stateRef.current.transform;
      dispatch({
        type: 'SET_TRANSFORM',
        transform: { ...t, x: t.x + dx, y: t.y + dy },
      });
      return;
    }

    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerMove?.(toolCtx, e);
  }, [toolCtx, dispatch]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (middlePanning.current) {
      middlePanning.current = false;
      return;
    }

    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerUp?.(toolCtx, e);
  }, [toolCtx]);

  const handler = getToolHandler(activeTool);
  const cursorClass = `cursor-${handler.cursor}`;

  if (!viewBox) {
    return (
      <div className="canvas empty-canvas">
        <div className="empty-state">
          <div className="empty-icon">&#x25C7;</div>
          <p>Select a floor to view</p>
        </div>
      </div>
    );
  }

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div
      ref={containerRef}
      className={`canvas ${cursorClass}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onDoubleClick={(e) => {
        const elementId = findElementId(e.target);
        if (elementId && selectedIds.has(elementId)) {
          dispatch({ type: 'SET_EDIT_MODE', active: !state.editMode });
        }
      }}
    >
      <svg
        ref={svgRef}
        className="canvas-svg"
        viewBox={vb}
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {/* Grid layer */}
        {gridSvg && (
          <g className="grid-layer" dangerouslySetInnerHTML={{ __html: gridSvg }} />
        )}

        {/* Data layers */}
        {layers.map(layer => (
          <g
            key={layer.key}
            className={`data-layer ${activeFilter && layer.tableName !== activeFilter ? 'dimmed' : ''}`}
            data-layer={layer.key}
            dangerouslySetInnerHTML={{ __html: layer.html }}
          />
        ))}

        {/* Selection overlay */}
        <SelectionOverlay svgRef={svgRef} selectedIds={selectedIds} />

        {/* Resize handles in edit mode */}
        {state.editMode && selectedIds.size === 1 && state.document && (() => {
          const id = selectedIds.values().next().value!;
          const el = state.document.elements.get(id);
          return el ? <ResizeHandles element={el} svgRef={svgRef} /> : null;
        })()}

        {/* Drawing preview overlay */}
        {state.drawingState && (
          <DrawingOverlay drawingState={state.drawingState} activeTool={activeTool} />
        )}
      </svg>

      {/* Marquee */}
      {state.marquee && <MarqueeSelection marquee={state.marquee} />}

      {/* Minimap */}
      <Minimap layers={layers} viewBox={viewBox} gridSvg={gridSvg} />

      {/* Hover tooltip */}
      {hoveredId && (
        <div className="hover-tooltip">
          <span className="hover-type">{getElementType(hoveredId)}</span>
          {hoveredId}
        </div>
      )}

      {/* Status bar */}
      <div className="canvas-status">
        <span className="status-tool">
          {activeTool === 'select' ? '⬚ Select'
            : activeTool === 'pan' ? '✋ Pan'
            : activeTool === 'zoom' ? '🔍 Zoom'
            : activeTool.startsWith('draw_') ? '✏ Draw'
            : activeTool}
        </span>
        {selectedIds.size > 0 && (
          <span className="status-selection">{selectedIds.size} selected</span>
        )}
        <span className="status-zoom">{(transform.scale * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function getElementType(id: string): string {
  const prefix = id.replace(/-\d+$/, '');
  const prefixMap: Record<string, string> = {
    w: 'wall', sw: 'structure_wall', c: 'column', sc: 'structure_column',
    d: 'door', wi: 'window', sp: 'space', sl: 'slab', ssl: 'structure_slab',
    st: 'stair', du: 'duct', pi: 'pipe', eq: 'equipment', te: 'terminal',
    co: 'conduit', ct: 'cable_tray', be: 'beam', br: 'brace',
  };
  const tableName = prefixMap[prefix];
  const style = tableName ? LAYER_STYLES[tableName] : undefined;
  return style?.displayName || prefix;
}
