import { useRef, useCallback, useEffect, useState, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer, EditorAction } from '../state/editorTypes.ts';
import type { ViewTransform } from '../state/editorTypes.ts';
import { LAYER_STYLES } from '../types.ts';
import { getToolHandler } from '../tools/registry.ts';
import type { ToolContext, ToolStateSnapshot, TransformAction } from '../tools/types.ts';
import type { SnapResult } from '../utils/snap.ts';
import SelectionOverlay from './SelectionOverlay.tsx';
import MarqueeSelection from './MarqueeSelection.tsx';
import DrawingOverlay from './DrawingOverlay.tsx';
import ResizeHandles from './ResizeHandles.tsx';
import SnapOverlay from './SnapOverlay.tsx';
import Minimap from './Minimap.tsx';
import { ElementNode, pruneCache } from './ElementNode.tsx';
import { REVERSE_PREFIX_MAP } from '../model/ids.ts';
import { WallOutlines } from './WallOutlines.tsx';
import { renderSpaceLabels } from '../renderers/spaceRenderer.tsx';
import { Icon } from './Icons.tsx';
import CanvasContextMenu from './CanvasContextMenu.tsx';

// Safari-only event for trackpad pinch gestures
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

interface CanvasProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number } | null;
  activeFilter: string | null;
  activeDiscipline: string | null;
}

type CanvasAction = EditorAction | TransformAction;

export interface CanvasHandle {
  zoomToFit: () => void;
  getScale: () => number;
}

export default forwardRef<CanvasHandle, CanvasProps>(function Canvas({ layers, viewBox, activeFilter, activeDiscipline }, ref) {
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

  // ────── LOCAL SNAP STATE ──────
  const [activeSnap, setActiveSnap] = useState<SnapResult | null>(null);

  // ────── CONTEXT MENU STATE ──────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);

  // ────── ANIMATED TRANSFORM ──────
  const [animating, setAnimating] = useState(false);

  // Reset transform when level changes
  useEffect(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
  }, [state.currentLevel]);

  // Prune SVG cache when elements change to prevent memory leaks
  const elements = state.document?.elements;
  useEffect(() => {
    if (elements) pruneCache(new Set(elements.keys()));
  }, [elements]);

  // UI scale correction: compute SVG-units-per-pixel at scale=1.
  // Cached in ref, only recomputed when viewBox changes (not on every render).
  const uiScaleRef = useRef(1);
  if (viewBox && containerRef.current) {
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (cw > 0 && ch > 0) {
      // SVG preserveAspectRatio="xMidYMid meet" → scale = min(cw/vb.w, ch/vb.h)
      const svgToPixel = Math.min(cw / viewBox.w, ch / viewBox.h);
      // Reference: 15 px/unit was the original calibration
      uiScaleRef.current = svgToPixel / 15;
    }
  }
  const uiScale = uiScaleRef.current;

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
    setAnimating(true);
    setTransform({ x: 0, y: 0, scale: 1 });
    setTimeout(() => setAnimating(false), 300);
  }, []);

  const applyZoomToPercent = useCallback((percent: number) => {
    setTransform(prev => ({ ...prev, scale: percent / 100 }));
  }, []);

  useImperativeHandle(ref, () => ({
    zoomToFit: applyZoomToFit,
    getScale: () => transformRef.current.scale,
  }), [applyZoomToFit]);

  const applyZoomToBBox = useCallback((minX: number, minY: number, maxX: number, maxY: number) => {
    const el = containerRef.current;
    if (!el || !viewBox) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    const margin = 80;
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const svgToPixel = Math.min(cw / viewBox.w, ch / viewBox.h);
    const scale = Math.min((cw - margin * 2) / (bw * svgToPixel), (ch - margin * 2) / (bh * svgToPixel));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const px = (cx - viewBox.x) * svgToPixel;
    const py = (-cy - viewBox.y) * svgToPixel;
    const tx = cw / 2 - px * scale;
    const ty = ch / 2 - py * scale;
    setTransform({ x: tx, y: ty, scale });
  }, [viewBox]);

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
      case 'ZOOM_TO_BBOX':
        applyZoomToBBox(action.minX, action.minY, action.maxX, action.maxY);
        return;
      default:
        globalDispatch(action);
    }
  }, [globalDispatch, applyZoomBy, applyZoomToFit, applyZoomToPercent, applyZoomToBBox]);

  // Track last gesture scale to compute incremental delta
  const lastGestureScale = useRef(1);

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
        drawingAttrs: s.drawingAttrs,
        drawingState: s.drawingState,
        document: s.document,
        project: s.project,
        grids: s.grids,
      };
    },
    screenToSvg,
    findElementId,
    setSnap: setActiveSnap,
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

  // Native wheel + gesture listeners with { passive: false } so
  // preventDefault() actually suppresses browser zoom on trackpad.
  const hasViewBox = !!viewBox;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad (or Ctrl+scroll with mouse wheel)
        const delta = Math.pow(2, -e.deltaY * 0.01);
        const rect = el.getBoundingClientRect();
        applyZoomBy(delta, e.clientX - rect.left, e.clientY - rect.top);
      } else if (e.deltaX === 0 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 4) {
        // Mouse wheel (no horizontal component, pixel mode, discrete steps) → zoom
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const rect = el.getBoundingClientRect();
        applyZoomBy(delta, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        // Two-finger scroll on trackpad → pan
        setTransform(prev => ({
          ...prev,
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    // Safari fires gesture events for trackpad pinch instead of wheel+ctrlKey
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastGestureScale.current = (e as GestureEvent).scale;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as GestureEvent;
      const delta = ge.scale / lastGestureScale.current;
      lastGestureScale.current = ge.scale;
      const rect = el.getBoundingClientRect();
      applyZoomBy(delta, ge.clientX - rect.left, ge.clientY - rect.top);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false });
    el.addEventListener('gesturechange', onGestureChange, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [applyZoomBy, hasViewBox]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setContextMenu(null);

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
      <div className="canvas flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mb-3 block text-5xl text-[var(--color-accent)] opacity-30">&#x25C7;</div>
          <p className="text-[13px]">Select a floor to view</p>
        </div>
      </div>
    );
  }

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div
      ref={containerRef}
      className={`canvas ${cursorClass}`}
      style={{
        '--canvas-scale': transform.scale * uiScale,
      } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        if (stateRef.current.activeTool.startsWith('draw_')) {
          if (stateRef.current.drawingState?.points.length) {
            globalDispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          } else {
            globalDispatch({ type: 'SET_TOOL', tool: 'select' });
            globalDispatch({ type: 'SET_DRAWING_STATE', state: null });
            globalDispatch({ type: 'SET_DRAWING_TARGET', target: null });
          }
          return;
        }
        const targetId = findElementId(e.target);
        if (targetId && !stateRef.current.selectedIds.has(targetId)) {
          globalDispatch({ type: 'SELECT', ids: [targetId] });
        }
        setContextMenu({ x: e.clientX, y: e.clientY, targetId });
      }}
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
          overflow: 'visible',
          transition: animating ? 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)' : 'none',
        }}
      >
        {/* Data layers + wall outlines inserted between wall fills and doors/windows */}
        {(() => {
          const BELOW_OUTLINE = new Set(['wall', 'structure_wall', 'curtain_wall', 'duct', 'pipe', 'conduit', 'cable_tray', 'space', 'slab', 'structure_slab', 'stair']);
          const nodes: React.ReactNode[] = [];
          let outlineInserted = false;

          for (const layer of layers) {
            const isBackground = (layer.discipline === 'architechture' && activeDiscipline !== 'architechture')
              || (layer.discipline === 'reference' && activeDiscipline !== 'reference');
            const layerStyle = isBackground ? { pointerEvents: 'none' as const, opacity: 0.35 } : undefined;
            const className = `data-layer ${activeFilter && layer.tableName !== activeFilter ? 'dimmed' : ''} ${isBackground ? 'background-layer' : ''}`;
            const isBelowOutline = BELOW_OUTLINE.has(layer.tableName);

            if (!outlineInserted && !isBelowOutline) {
              nodes.push(<WallOutlines key="__wall_outlines__" layers={layers} />);
              outlineInserted = true;
            }

            nodes.push(
              <g key={layer.key} className={className} data-layer={layer.key} style={layerStyle}>
                {layer.elements.map(el => (
                  <ElementNode key={el.id} element={el} viewBoxStr={vb} />
                ))}
              </g>
            );
          }

          if (!outlineInserted) nodes.push(<WallOutlines key="__wall_outlines__" layers={layers} />);
          return nodes;
        })()}

        {/* Space labels — rendered above slabs so text is clickable and visible */}
        <g className="space-labels" transform="scale(1,-1)">
          {layers.filter(l => l.tableName === 'space').flatMap(l => renderSpaceLabels(l.elements))}
        </g>

        {/* Selection overlay */}
        <SelectionOverlay document={state.document} selectedIds={selectedIds} scale={transform.scale * uiScale} />

        {/* Resize handles */}
        {state.document && (() => {
          const handles = [];
          for (const id of selectedIds) {
            const el = state.document.elements.get(id);
            if (!el) continue;
            // Always show handles for point geometry to indicate selection
            // For lines/polygons, only show handles if it's the ONLY item selected
            if (el.geometry === 'point' || selectedIds.size === 1) {
              handles.push(<ResizeHandles key={id} element={el} svgRef={svgRef} scale={transform.scale * uiScale} onSnap={setActiveSnap} />);
            }
          }
          return handles;
        })()}

        {/* Snap guides */}
        <SnapOverlay snap={activeSnap} scale={transform.scale * uiScale} />

        {/* Drawing preview overlay */}
        {state.drawingState && (
          <DrawingOverlay drawingState={state.drawingState} activeTool={activeTool} scale={transform.scale * uiScale} drawingAttrs={state.drawingAttrs} tableName={state.drawingTarget?.tableName ?? null} />
        )}
      </svg>

      {/* Marquee */}
      {state.marquee && <MarqueeSelection marquee={state.marquee} />}

      {/* Minimap */}
      <Minimap layers={layers} viewBox={viewBox} transform={transform} setTransform={setTransform} containerRef={containerRef} />

      {/* Context menu */}
      {contextMenu && state.document && (
        <CanvasContextMenu
          menu={contextMenu}
          selectedIds={selectedIds}
          document={state.document}
          visibleLayers={state.visibleLayers}
          dispatch={globalDispatch}
          canvasDispatch={dispatch as (action: { type: string; [k: string]: unknown }) => void}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Hover tooltip */}
      {hoveredId && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium tabular-nums animate-in fade-in slide-in-from-bottom-1 duration-150">
          <span className="text-[10px] font-normal text-muted-foreground">{getElementType(hoveredId)}</span>
          {hoveredId}
        </div>
      )}

    </div>
  );
});

function getElementType(id: string): string {
  const prefix = id.replace(/-\d+$/, '');
  const tableName = REVERSE_PREFIX_MAP[prefix];
  const style = tableName ? LAYER_STYLES[tableName] : undefined;
  return style?.displayName || prefix;
}
