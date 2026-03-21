import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer, EditorAction } from '../state/editorTypes.ts';
import type { ViewTransform } from '../state/editorTypes.ts';
import type { GridData } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { getToolHandler } from '../tools/registry.ts';
import type { ToolContext, ToolStateSnapshot } from '../tools/types.ts';
import SelectionOverlay from './SelectionOverlay.tsx';
import MarqueeSelection from './MarqueeSelection.tsx';
import DrawingOverlay from './DrawingOverlay.tsx';
import ResizeHandles from './ResizeHandles.tsx';
import Minimap from './Minimap.tsx';
import { ElementNode } from './ElementNode.tsx';

interface CanvasProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number } | null;
  grids: GridData[];
  showGrid: boolean;
  activeFilter: string | null;
  activeDiscipline: string | null;
}

// Extended action type: includes both global EditorAction and Canvas-local transform actions
type TransformAction =
  | { type: 'SET_TRANSFORM'; transform: ViewTransform }
  | { type: 'ZOOM_BY'; delta: number; centerX?: number; centerY?: number }
  | { type: 'ZOOM_TO_FIT' }
  | { type: 'ZOOM_TO_PERCENT'; percent: number };

type CanvasAction = EditorAction | TransformAction;

export default function Canvas({ layers, viewBox, grids, showGrid, activeFilter, activeDiscipline }: CanvasProps) {
  const state = useEditorState();
  const globalDispatch = useEditorDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // ────── LOCAL TRANSFORM STATE ──────
  // Transform (pan/zoom) lives here instead of global context to avoid
  // full-tree re-renders on every 60fps mouse-move/wheel tick.
  const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Reset transform when level changes
  useEffect(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
  }, [state.currentLevel]);

  // ────── GRID SVG (depends on local transform.scale) ──────
  const gridSvg = useMemo(() => {
    if (!showGrid || grids.length === 0) return undefined;

    return grids.map(g => {
      const dx = Math.abs(g.x2 - g.x1);
      const dy = Math.abs(g.y2 - g.y1);
      const isShort = Math.sqrt(dx * dx + dy * dy) < 1;
      if (isShort) return '';

      const ext = 200;
      const ldx = g.x2 - g.x1;
      const ldy = g.y2 - g.y1;
      const len = Math.sqrt(ldx * ldx + ldy * ldy);
      const ux = ldx / len, uy = ldy / len;

      const x1 = g.x1 - ux * ext;
      const y1 = -(g.y1 - uy * ext);
      const x2 = g.x2 + ux * ext;
      const y2 = -(g.y2 + uy * ext);

      const lx = g.x1;
      const ly = -g.y1;

      return `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
              stroke="#ef476f" stroke-width="${0.06 / transform.scale}" stroke-dasharray="${0.45 / transform.scale},${0.3 / transform.scale}" opacity="0.4" />
        <circle cx="${lx}" cy="${ly}" r="${1.05 / transform.scale}" fill="none" stroke="#ef476f" stroke-width="${0.06 / transform.scale}" opacity="0.5" />
        <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central"
              font-size="${0.84 / transform.scale}" font-family="Inter, sans-serif" font-weight="600" fill="#ef476f" opacity="0.6">
          ${g.number}
        </text>
      `;
    }).join('');
  }, [showGrid, grids, transform.scale]);

  // ────── TRANSFORM MATH (local, no context dispatch) ──────
  const applyZoomBy = useCallback((delta: number, centerX?: number, centerY?: number) => {
    setTransform(prev => {
      const newScale = Math.min(Math.max(prev.scale * delta, 0.05), 100);
      if (centerX !== undefined && centerY !== undefined) {
        const ratio = newScale / prev.scale;
        return {
          scale: newScale,
          x: centerX - (centerX - prev.x) * ratio,
          y: centerY - (centerY - prev.y) * ratio,
        };
      }
      return { ...prev, scale: newScale };
    });
  }, []);

  const applyZoomToFit = useCallback(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
  }, []);

  const applyZoomToPercent = useCallback((percent: number) => {
    setTransform(prev => ({ ...prev, scale: percent / 100 }));
  }, []);

  // Wrap globalDispatch: intercept transform actions locally
  const dispatch = useCallback((action: CanvasAction) => {
    switch (action.type) {
      case 'SET_TRANSFORM':
        setTransform(action.transform);
        return;
      case 'ZOOM_BY':
        applyZoomBy(action.delta, action.centerX, action.centerY);
        return;
      case 'ZOOM_TO_FIT':
        applyZoomToFit();
        return;
      case 'ZOOM_TO_PERCENT':
        applyZoomToPercent(action.percent);
        return;
      default:
        globalDispatch(action);
    }
  }, [globalDispatch, applyZoomBy, applyZoomToFit, applyZoomToPercent]);

  // Middle-mouse panning (works across all tools)
  const middlePanning = useRef(false);
  const middleLastPos = useRef({ x: 0, y: 0 });

  const { activeTool, hoveredId, selectedIds } = state;

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
        transform: transformRef.current,
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
          if (stateRef.current.drawingState?.points.length) {
            // Cancel drawing in progress
            globalDispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          } else if (stateRef.current.activeTool.startsWith('draw_')) {
            // Exit drawing tool back to select
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
                    allIds.push(id);
                  }
                }
              }
            }
            globalDispatch({ type: 'SELECT', ids: allIds });
          }
          break;
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
  }, [globalDispatch, applyZoomBy, applyZoomToFit, applyZoomToPercent]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    applyZoomBy(delta, e.clientX - rect.left, e.clientY - rect.top);
  }, [applyZoomBy]);

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
      setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      return;
    }

    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerMove?.(toolCtx, e);
  }, [toolCtx]);

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
      style={{ '--canvas-scale': transform.scale } as React.CSSProperties}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onDoubleClick={(e) => {
        const elementId = findElementId(e.target);
        if (elementId && selectedIds.has(elementId)) {
          globalDispatch({ type: 'SET_EDIT_MODE', active: !state.editMode });
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
        {layers.map(layer => {
          const isBackground = layer.discipline === 'architectural' && activeDiscipline !== 'architectural';
          const layerStyle = isBackground ? { pointerEvents: 'none' as const, opacity: 0.35 } : undefined;
          const className = `data-layer ${activeFilter && layer.tableName !== activeFilter ? 'dimmed' : ''} ${isBackground ? 'background-layer' : ''}`;

          // Document mode: render each element as a React.memo component for O(1) updates
          if (layer.elements) {
            return (
              <g key={layer.key} className={className} data-layer={layer.key} style={layerStyle}>
                {layer.elements.map(el => (
                  <ElementNode key={el.id} element={el} viewBoxStr={vb} />
                ))}
              </g>
            );
          }

          // Read-only mode: use pre-rendered HTML string
          return (
            <g
              key={layer.key}
              className={className}
              data-layer={layer.key}
              style={layerStyle}
              dangerouslySetInnerHTML={{ __html: layer.html }}
            />
          );
        })}

        {/* Selection overlay */}
        <SelectionOverlay document={state.document} selectedIds={selectedIds} scale={transform.scale} />

        {/* Resize handles */}
        {state.document && (() => {
          const handles = [];
          for (const id of selectedIds) {
            const el = state.document.elements.get(id);
            if (!el) continue;
            // Always show handles for point geometry to indicate selection
            // For lines/polygons, only show handles if it's the ONLY item selected
            if (el.geometry === 'point' || selectedIds.size === 1) {
              handles.push(<ResizeHandles key={id} element={el} svgRef={svgRef} scale={transform.scale} />);
            }
          }
          return handles;
        })()}

        {/* Drawing preview overlay */}
        {state.drawingState && (
          <DrawingOverlay drawingState={state.drawingState} activeTool={activeTool} scale={transform.scale} />
        )}
      </svg>

      {/* Marquee */}
      {state.marquee && <MarqueeSelection marquee={state.marquee} />}

      {/* Minimap */}
      <Minimap layers={layers} viewBox={viewBox} gridSvg={gridSvg} transform={transform} setTransform={setTransform} />

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
