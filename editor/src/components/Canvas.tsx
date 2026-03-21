import { useRef, useCallback, useEffect } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer } from '../state/editorTypes.ts';
import { LAYER_STYLES } from '../types.ts';
import SelectionOverlay from './SelectionOverlay.tsx';
import MarqueeSelection from './MarqueeSelection.tsx';
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
  const isPanning = useRef(false);
  const isMarquee = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const marqueeStart = useRef({ x: 0, y: 0 });

  const { transform, activeTool, hoveredId, selectedIds } = state;

  // Hover highlight — add/remove CSS class on hovered elements
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Clear previous highlights
    svg.querySelectorAll('.hover-highlight').forEach(el => el.classList.remove('hover-highlight'));

    if (hoveredId) {
      svg.querySelectorAll(`[data-id="${hoveredId}"]`).forEach(el => el.classList.add('hover-highlight'));
    }
  }, [hoveredId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'v': case 'V':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'select' });
          break;
        case 'h': case 'H':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'pan' });
          break;
        case 'z': case 'Z':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'zoom' });
          break;
        case ' ':
          e.preventDefault();
          dispatch({ type: 'SET_SPACE_HELD', held: true });
          break;
        case 'Escape':
          dispatch({ type: 'CLEAR_SELECTION' });
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
            // Select all visible elements
            const allIds: string[] = [];
            const floor = state.project?.floors.get(state.currentLevel);
            if (floor) {
              for (const layer of floor.layers) {
                if (state.visibleLayers.has(`${layer.discipline}/${layer.tableName}`)) {
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
  }, [dispatch, state.project, state.currentLevel, state.visibleLayers]);

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

  const findElementId = useCallback((target: EventTarget | null): string | null => {
    let el = target as Element | null;
    while (el && el !== svgRef.current) {
      const id = el.getAttribute('data-id') || el.getAttribute('id');
      if (id && /^[a-z]+-\d+$/i.test(id)) return id;
      el = el.parentElement;
    }
    return null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Middle mouse always pans
    if (e.button === 1) {
      isPanning.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const currentTool = activeTool;

    if (currentTool === 'pan') {
      isPanning.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }

    if (currentTool === 'zoom') {
      const delta = e.altKey ? 0.7 : 1.4;
      dispatch({
        type: 'ZOOM_BY',
        delta,
        centerX: e.clientX - rect.left,
        centerY: e.clientY - rect.top,
      });
      return;
    }

    // Select tool
    const elementId = findElementId(e.target);
    if (elementId) {
      dispatch({ type: 'SELECT', ids: [elementId], additive: e.shiftKey });
    } else {
      // Start marquee or clear selection
      if (!e.shiftKey) {
        dispatch({ type: 'CLEAR_SELECTION' });
      }
      isMarquee.current = true;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      marqueeStart.current = { x: sx, y: sy };
      dispatch({ type: 'SET_MARQUEE', marquee: { x1: sx, y1: sy, x2: sx, y2: sy } });
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  }, [activeTool, dispatch, findElementId]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning.current) {
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      dispatch({
        type: 'SET_TRANSFORM',
        transform: {
          ...transform,
          x: transform.x + dx,
          y: transform.y + dy,
        },
      });
      return;
    }

    if (isMarquee.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dispatch({
        type: 'SET_MARQUEE',
        marquee: {
          x1: marqueeStart.current.x,
          y1: marqueeStart.current.y,
          x2: e.clientX - rect.left,
          y2: e.clientY - rect.top,
        },
      });
      return;
    }

    // Hover detection
    const elementId = findElementId(e.target);
    if (elementId !== hoveredId) {
      dispatch({ type: 'SET_HOVER', id: elementId });
    }
  }, [transform, hoveredId, dispatch, findElementId]);

  const handlePointerUp = useCallback(() => {
    if (isMarquee.current && state.marquee) {
      // Find elements within marquee
      isMarquee.current = false;
      const marqueeRect = {
        x: Math.min(state.marquee.x1, state.marquee.x2),
        y: Math.min(state.marquee.y1, state.marquee.y2),
        w: Math.abs(state.marquee.x2 - state.marquee.x1),
        h: Math.abs(state.marquee.y2 - state.marquee.y1),
      };

      // Only select if marquee is big enough
      if (marqueeRect.w > 5 || marqueeRect.h > 5) {
        const svg = svgRef.current;
        if (svg) {
          const ids = new Set<string>();
          const elements = svg.querySelectorAll('[data-id]');
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (containerRect) {
            for (const el of elements) {
              try {
                const bbox = (el as SVGGraphicsElement).getBBox();
                const ctm = (el as SVGGraphicsElement).getCTM();
                if (!ctm) continue;

                // Transform bbox to screen space
                const svgEl = svg;
                const pt1 = svgEl.createSVGPoint();
                pt1.x = bbox.x;
                pt1.y = bbox.y;
                const screenPt1 = pt1.matrixTransform(ctm);

                const pt2 = svgEl.createSVGPoint();
                pt2.x = bbox.x + bbox.width;
                pt2.y = bbox.y + bbox.height;
                const screenPt2 = pt2.matrixTransform(ctm);

                const elRect = {
                  x: Math.min(screenPt1.x, screenPt2.x) - containerRect.left,
                  y: Math.min(screenPt1.y, screenPt2.y) - containerRect.top,
                  w: Math.abs(screenPt2.x - screenPt1.x),
                  h: Math.abs(screenPt2.y - screenPt1.y),
                };

                // Check intersection
                if (
                  elRect.x < marqueeRect.x + marqueeRect.w &&
                  elRect.x + elRect.w > marqueeRect.x &&
                  elRect.y < marqueeRect.y + marqueeRect.h &&
                  elRect.y + elRect.h > marqueeRect.y
                ) {
                  const id = el.getAttribute('data-id');
                  if (id) ids.add(id);
                }
              } catch {
                // getBBox can throw for hidden elements
              }
            }
          }
          if (ids.size > 0) {
            dispatch({ type: 'SELECT', ids: Array.from(ids) });
          }
        }
      }
      dispatch({ type: 'SET_MARQUEE', marquee: null });
      return;
    }

    isPanning.current = false;
    isMarquee.current = false;
  }, [state.marquee, dispatch]);

  const cursorClass = activeTool === 'pan' ? 'cursor-grab' : activeTool === 'zoom' ? 'cursor-zoom' : 'cursor-default';

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
          {activeTool === 'select' ? '⬚ Select' : activeTool === 'pan' ? '✋ Pan' : '🔍 Zoom'}
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
