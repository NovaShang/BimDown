import { useRef, useCallback, useEffect, useState, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useCoreEditorState, useSelectionState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer, EditorAction } from '../state/editorTypes.ts';
import { LAYER_STYLES } from '../types.ts';
import { getToolHandler } from '../tools/registry.ts';
import type { ToolContext, ToolStateSnapshot, TransformAction } from '../tools/types.ts';
import type { SnapResult } from '../utils/snap.ts';
import { useCanvasTransform } from '../hooks/useCanvasTransform.ts';
import { useCanvasKeyboard } from '../hooks/useCanvasKeyboard.ts';
import SVGLayers from './SVGLayers.tsx';
import SelectionOverlay from './SelectionOverlay.tsx';
import MarqueeSelection from './MarqueeSelection.tsx';
import DrawingOverlay from './DrawingOverlay.tsx';
import ResizeHandles from './ResizeHandles.tsx';
import SnapOverlay from './SnapOverlay.tsx';
import Minimap from './Minimap.tsx';
import { pruneCache } from './ElementNode.tsx';
import { REVERSE_PREFIX_MAP, toSelectionId, toElementId } from '../model/ids.ts';
import CanvasContextMenu from './CanvasContextMenu.tsx';
import CanvasOverlay from './CanvasOverlay.tsx';

import type { ProjectData } from '../types.ts';
import type { DocumentState } from '../model/document.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseLayer } from '../model/parse.ts';

/** Look up an element by selection ID, checking document first, then globalLayers. */
function findCanonicalElement(
  sid: string,
  document: DocumentState | null,
  project: ProjectData | null,
): CanonicalElement | undefined {
  if (sid.startsWith('global:') && project) {
    const rawId = sid.slice('global:'.length);
    for (const gl of project.globalLayers) {
      const parsed = parseLayer(gl);
      const el = parsed.find(e => e.id === rawId);
      if (el) return el;
    }
    return undefined;
  }
  return document?.elements.get(toElementId(sid));
}

// Safari-only event for trackpad pinch gestures
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

type Pt = { x: number; y: number };
const touchDist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const touchMid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

interface CanvasProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number } | null;
  activeFilter: string | null;
  activeDiscipline: string | null;
  overlayItems?: import('../hooks/useOverlayItems.ts').OverlayItem[];
}

type CanvasAction = EditorAction | TransformAction;

export interface CanvasHandle {
  zoomToFit: () => void;
  getScale: () => number;
}

export default forwardRef<CanvasHandle, CanvasProps>(function Canvas({ layers, viewBox, activeFilter, activeDiscipline, overlayItems }, ref) {
  const state = useCoreEditorState();
  const globalDispatch = useEditorDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // UI scale correction: SVG-units-per-pixel at scale=1.
  const uiScaleRef = useRef(1);
  if (viewBox && containerRef.current) {
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (cw > 0 && ch > 0) {
      const svgToPixel = Math.min(cw / viewBox.w, ch / viewBox.h);
      uiScaleRef.current = svgToPixel / 15;
    }
  }
  const uiScale = uiScaleRef.current;

  // ────── TRANSFORM (ref-based, pan bypasses React) ──────
  const {
    transformRef, updateTransform,
    applyZoomBy, applyZoomToFit, applyZoomToPercent, applyZoomToBBox,
    subscribeTransform,
  } = useCanvasTransform({ svgRef, containerRef, uiScaleRef, viewBox, currentLevel: state.currentLevel });

  useImperativeHandle(ref, () => ({
    zoomToFit: applyZoomToFit,
    getScale: () => transformRef.current.scale,
  }), [applyZoomToFit, transformRef]);

  // ────── LOCAL SNAP STATE ──────
  const [activeSnap, setActiveSnap] = useState<SnapResult | null>(null);

  // ────── CONTEXT MENU STATE ──────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);

  // Clear snap guides when exiting draw mode
  useEffect(() => {
    if (!state.drawingState && !state.activeTool.startsWith('draw_')) {
      setActiveSnap(null);
    }
  }, [state.drawingState, state.activeTool]);

  // Prune SVG cache when elements change to prevent memory leaks
  const elements = state.document?.elements;
  useEffect(() => {
    if (elements) pruneCache(new Set(elements.keys()));
  }, [elements]);

  // ────── DISPATCH WRAPPER (intercepts transform actions) ──────
  const dispatch = useCallback((action: CanvasAction) => {
    switch (action.type) {
      case 'SET_TRANSFORM':
        updateTransform(action.transform);
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
  }, [globalDispatch, updateTransform, applyZoomBy, applyZoomToFit, applyZoomToPercent, applyZoomToBBox]);

  // ────── REFS ──────
  const { activeTool, selectedIds } = state;
  const stateRef = useRef(state);
  stateRef.current = state;

  const lastGestureScale = useRef(1);
  const gestureActive = useRef(false);
  const middlePanning = useRef(false);
  const middleLastPos = useRef({ x: 0, y: 0 });

  // ────── TOUCH GESTURE STATE ──────
  const touchPointers = useRef(new Map<number, { x: number; y: number }>());
  const touchMode = useRef<'none' | 'pan' | 'pinch'>('none');
  const touchStartTime = useRef(0);
  const touchStartPos = useRef({ x: 0, y: 0 });
  const touchPrevDist = useRef(0);
  const touchPrevMid = useRef({ x: 0, y: 0 });

  // ────── SVG HELPERS ──────
  const findElementId = useCallback((target: EventTarget | null): string | null => {
    let el = target as Element | null;
    while (el && el !== svgRef.current) {
      const id = el.getAttribute('data-id') || el.getAttribute('id');
      if (id) {
        // Global-prefixed IDs (from globalLayers) are already fully qualified
        if (id.startsWith('global:')) return id;
        // Regular element IDs: prefix with current level
        if (/^[a-z]+-\d+$/i.test(id)) {
          return state.currentLevel ? toSelectionId(state.currentLevel, id) : id;
        }
      }
      el = el.parentElement;
    }
    return null;
  }, [state.currentLevel]);

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
        currentLevel: s.currentLevel,
      };
    },
    screenToSvg,
    findElementId,
    setSnap: setActiveSnap,
  }), [dispatch, screenToSvg, findElementId, transformRef]);

  // ────── KEYBOARD SHORTCUTS ──────
  useCanvasKeyboard({
    globalDispatch, stateRef, applyZoomBy, applyZoomToFit, applyZoomToPercent, activeDiscipline,
  });

  // ────── WHEEL + GESTURE LISTENERS ──────
  const hasViewBox = !!viewBox;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const delta = Math.pow(2, -e.deltaY * 0.01);
        const rect = el.getBoundingClientRect();
        applyZoomBy(delta, e.clientX - rect.left, e.clientY - rect.top);
      } else if (e.deltaX === 0 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 4) {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const rect = el.getBoundingClientRect();
        applyZoomBy(delta, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        updateTransform(prev => ({
          ...prev,
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureActive.current = true;
      lastGestureScale.current = (e as GestureEvent).scale;
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureActive.current = false;
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
    el.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [applyZoomBy, updateTransform, hasViewBox]);

  // ────── POINTER HANDLERS ──────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setContextMenu(null);

    // ── Touch input ──
    if (e.pointerType === 'touch') {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      touchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchPointers.current.size === 1) {
        // Start single-finger pan
        touchMode.current = 'pan';
        touchStartTime.current = Date.now();
        touchStartPos.current = { x: e.clientX, y: e.clientY };
      } else if (touchPointers.current.size >= 2) {
        // Switch to pinch mode
        touchMode.current = 'pinch';
        const pts = Array.from(touchPointers.current.values());
        touchPrevDist.current = touchDist(pts[0], pts[1]);
        touchPrevMid.current = touchMid(pts[0], pts[1]);
      }
      return;
    }

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
    // ── Touch input ──
    if (e.pointerType === 'touch') {
      const prev = touchPointers.current.get(e.pointerId);
      if (!prev) return;
      touchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchMode.current === 'pan' && touchPointers.current.size === 1) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        updateTransform(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      } else if (touchMode.current === 'pinch' && touchPointers.current.size >= 2 && !gestureActive.current) {
        const pts = Array.from(touchPointers.current.values());
        const dist = touchDist(pts[0], pts[1]);
        const mid = touchMid(pts[0], pts[1]);

        // Pinch zoom
        if (touchPrevDist.current > 0) {
          const delta = dist / touchPrevDist.current;
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            applyZoomBy(delta, mid.x - rect.left, mid.y - rect.top);
          }
        }

        // Two-finger pan
        const dx = mid.x - touchPrevMid.current.x;
        const dy = mid.y - touchPrevMid.current.y;
        updateTransform(p => ({ ...p, x: p.x + dx, y: p.y + dy }));

        touchPrevDist.current = dist;
        touchPrevMid.current = mid;
      }
      return;
    }

    if (middlePanning.current) {
      const dx = e.clientX - middleLastPos.current.x;
      const dy = e.clientY - middleLastPos.current.y;
      middleLastPos.current = { x: e.clientX, y: e.clientY };
      updateTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      return;
    }
    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerMove?.(toolCtx, e);
  }, [toolCtx, updateTransform, applyZoomBy]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // ── Touch input ──
    if (e.pointerType === 'touch') {
      const wasPointerCount = touchPointers.current.size;
      touchPointers.current.delete(e.pointerId);

      // Detect tap: single finger, short duration, minimal movement
      if (wasPointerCount === 1 && touchPointers.current.size === 0 && touchMode.current === 'pan') {
        const dt = Date.now() - touchStartTime.current;
        const dx = Math.abs(e.clientX - touchStartPos.current.x);
        const dy = Math.abs(e.clientY - touchStartPos.current.y);
        if (dt < 300 && dx < 10 && dy < 10) {
          // Tap → select element under finger
          const targetId = findElementId(e.target);
          if (targetId) {
            globalDispatch({ type: 'SELECT', ids: [targetId] });
          } else {
            globalDispatch({ type: 'CLEAR_SELECTION' });
          }
        }
      }

      // Reset mode when all fingers lifted
      if (touchPointers.current.size === 0) {
        touchMode.current = 'none';
      } else if (touchPointers.current.size === 1) {
        // Went from 2 fingers to 1: switch to pan
        touchMode.current = 'pan';
      }
      return;
    }

    if (middlePanning.current) {
      middlePanning.current = false;
      return;
    }
    const handler = getToolHandler(stateRef.current.activeTool);
    handler.onPointerUp?.(toolCtx, e);
  }, [toolCtx, findElementId, globalDispatch]);

  // ────── RENDER ──────
  const handler = getToolHandler(activeTool);
  const cursorClass = `cursor-${handler.cursor}`;
  const scale = transformRef.current.scale * uiScale;

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
  const t = transformRef.current;

  return (
    <div
      ref={containerRef}
      className={`canvas ${cursorClass}`}
      style={{ '--canvas-scale': t.scale * uiScale } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        if (stateRef.current.readonly) {
          // In readonly mode, only show view-related context menu
          const targetId = findElementId(e.target);
          if (targetId && !stateRef.current.selectedIds.has(targetId)) {
            globalDispatch({ type: 'SELECT', ids: [targetId] });
          }
          setContextMenu({ x: e.clientX, y: e.clientY, targetId });
          return;
        }
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
        if (state.readonly) return;
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
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transformOrigin: '0 0',
          overflow: 'visible',
          transition: 'none',
        }}
      >
        {/* Heavy SVG content — React.memo, never re-renders during pan/zoom */}
        <SVGLayers layers={layers} activeFilter={activeFilter} activeDiscipline={activeDiscipline} />

        {/* Lightweight overlays — only re-render when scale or selection changes */}
        <SelectionOverlay document={state.document} project={state.project} selectedIds={selectedIds} scale={scale} />

        {!state.readonly && (activeTool === 'select' || activeTool === 'orbit') && (() => {
          const handles = [];
          for (const sid of selectedIds) {
            const el = findCanonicalElement(sid, state.document, state.project);
            if (!el) continue;
            if (el.geometry === 'point' || selectedIds.size === 1) {
              handles.push(<ResizeHandles key={sid} element={el} svgRef={svgRef} scale={scale} onSnap={setActiveSnap} />);
            }
          }
          return handles;
        })()}

        <SnapOverlay snap={activeSnap} scale={scale} />

        {state.drawingState && (
          <DrawingOverlay drawingState={state.drawingState} activeTool={activeTool} scale={scale} drawingAttrs={state.drawingAttrs} tableName={state.drawingTarget?.tableName ?? null} />
        )}
      </svg>

      {state.marquee && <MarqueeSelection marquee={state.marquee} />}

      {overlayItems && overlayItems.length > 0 && (
        <CanvasOverlay
          items={overlayItems}
          svgRef={svgRef}
          containerRef={containerRef}
          subscribeTransform={subscribeTransform}
        />
      )}

      {state.showMinimap && (
        <Minimap
          layers={layers}
          viewBox={viewBox}
          transformRef={transformRef}
          updateTransform={updateTransform}
          subscribeTransform={subscribeTransform}
          containerRef={containerRef}
        />
      )}

      {contextMenu && state.document && (
        <CanvasContextMenu
          menu={contextMenu}
          selectedIds={selectedIds}
          document={state.document}
          visibleLayers={state.visibleLayers}
          dispatch={globalDispatch}
          canvasDispatch={dispatch as (action: { type: string; [k: string]: unknown }) => void}
          onClose={() => setContextMenu(null)}
          readonly={state.readonly}
        />
      )}

      <HoverHighlight svgRef={svgRef} />
      <HoverTooltip />
    </div>
  );
});

/** Applies CSS hover-highlight class via DOM manipulation — only re-renders on hoveredId change. */
function HoverHighlight({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  const { hoveredId } = useSelectionState();
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll('.hover-highlight').forEach(el => el.classList.remove('hover-highlight'));
    if (hoveredId) {
      svg.querySelectorAll(`[data-id="${hoveredId}"]`).forEach(el => el.classList.add('hover-highlight'));
    }
  }, [hoveredId, svgRef]);
  return null;
}

/** Hover tooltip — only re-renders on hoveredId change. */
function HoverTooltip() {
  const { hoveredId } = useSelectionState();
  if (!hoveredId) return null;
  return (
    <div className="pointer-events-none absolute bottom-14 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 glass-panel rounded border border-border px-2.5 py-1 text-[11px] font-medium tabular-nums animate-in fade-in slide-in-from-bottom-1 duration-150">
      <span className="text-[10px] font-normal text-muted-foreground">{getElementType(hoveredId)}</span>
      {hoveredId}
    </div>
  );
}

function getElementType(id: string): string {
  const prefix = id.replace(/-\d+$/, '');
  const tableName = REVERSE_PREFIX_MAP[prefix];
  const style = tableName ? LAYER_STYLES[tableName] : undefined;
  return style?.displayName || prefix;
}
