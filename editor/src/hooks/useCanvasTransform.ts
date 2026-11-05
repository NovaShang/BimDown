import { useRef, useCallback, useLayoutEffect, useState } from 'react';
import type { ViewTransform } from '../state/editorTypes.ts';
import { fitTransform, keepInPlace, measureOverlayInsets, sameBox, shouldAutoFit, type Box } from '../utils/fitView.ts';

export type TransformUpdater = ViewTransform | ((prev: ViewTransform) => ViewTransform);

interface UseCanvasTransformOptions {
  svgRef: React.RefObject<SVGSVGElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  uiScaleRef: React.MutableRefObject<number>;
  viewBox: Box | null;
  currentLevel: string;
  /** Current level's content extent (SVG units, grids excluded); null when the level is empty */
  contentBounds: Box | null;
  /** The user has edited this level (drawing the first wall must not refit the view) */
  userEdited: boolean;
}

/**
 * Manages canvas transform (pan/zoom) via direct DOM manipulation.
 * Pan updates bypass React entirely — only scale changes trigger re-renders
 * for overlays that need scale-dependent stroke widths.
 */
export function useCanvasTransform({ svgRef, containerRef, uiScaleRef, viewBox, currentLevel, contentBounds, userEdited }: UseCanvasTransformOptions) {
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  // Set by any user pan/zoom; auto-fit leaves the view alone after that
  const userMovedRef = useRef(false);
  // Incremented only when scale changes — triggers re-render for overlays
  const [, setScaleTick] = useState(0);
  // Listeners for external subscribers (Minimap)
  const listenersRef = useRef(new Set<() => void>());

  const syncDOM = useCallback(() => {
    const t = transformRef.current;
    if (svgRef.current) {
      svgRef.current.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    }
    if (containerRef.current) {
      containerRef.current.style.setProperty('--canvas-scale', String(t.scale * uiScaleRef.current));
    }
    for (const cb of listenersRef.current) cb();
  }, [svgRef, containerRef, uiScaleRef]);

  const setTransform = useCallback((updater: TransformUpdater, animated = false) => {
    const prev = transformRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    transformRef.current = next;
    if (!animated && svgRef.current) {
      svgRef.current.style.transition = 'none';
    }
    syncDOM();
    if (prev.scale !== next.scale) {
      setScaleTick(v => v + 1);
    }
  }, [syncDOM, svgRef]);

  /** Update transform (user pan/zoom). Direct DOM update; only triggers React re-render when scale changes. */
  const updateTransform = useCallback((updater: TransformUpdater, animated = false) => {
    userMovedRef.current = true;
    setTransform(updater, animated);
  }, [setTransform]);

  /** Fit the level's content into the canvas area not covered by floating panels. */
  const fitView = useCallback((animated: boolean) => {
    const el = containerRef.current;
    if (!el || !viewBox) return;
    const next = contentBounds
      ? fitTransform(contentBounds, viewBox, { w: el.clientWidth, h: el.clientHeight }, measureOverlayInsets(el))
      : { x: 0, y: 0, scale: 1 };
    if (!animated) { setTransform(next); return; }
    if (svgRef.current) {
      svgRef.current.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)';
    }
    setTransform(next, true);
    setTimeout(() => {
      if (svgRef.current) {
        svgRef.current.style.transition = 'none';
      }
    }, 300);
  }, [containerRef, viewBox, contentBounds, svgRef, setTransform]);

  // ────── AUTO-FIT ──────
  // Fit on project open / floor switch, and once when an empty level first
  // gets content (unless the user moved or edited meanwhile). When the viewBox
  // follows new content otherwise, keep the drawing where it is on screen.
  const fitStateRef = useRef<{ level: string | null; hadContent: boolean }>({ level: null, hadContent: false });
  const prevViewBoxRef = useRef<Box | null>(null);
  const hasContent = contentBounds !== null;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !viewBox) return;
    const prevViewBox = prevViewBoxRef.current;
    prevViewBoxRef.current = viewBox;
    const levelChanged = fitStateRef.current.level !== currentLevel;
    if (levelChanged) userMovedRef.current = false;
    const fit = shouldAutoFit(fitStateRef.current, { level: currentLevel, hasContent, userMoved: userMovedRef.current, userEdited });
    fitStateRef.current = { level: currentLevel, hadContent: hasContent };
    if (fit) {
      fitView(false);
    } else if (prevViewBox && !sameBox(prevViewBox, viewBox)) {
      setTransform(keepInPlace(transformRef.current, prevViewBox, viewBox, { w: el.clientWidth, h: el.clientHeight }));
    }
  }, [viewBox, currentLevel, hasContent, userEdited, containerRef, fitView, setTransform]);

  // ────── ZOOM FUNCTIONS ──────

  const applyZoomBy = useCallback((delta: number, centerX?: number, centerY?: number) => {
    updateTransform(prev => {
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
  }, [updateTransform]);

  const applyZoomToFit = useCallback(() => fitView(true), [fitView]);

  const applyZoomToPercent = useCallback((percent: number) => {
    updateTransform(prev => ({ ...prev, scale: percent / 100 }));
  }, [updateTransform]);

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
    updateTransform({ x: tx, y: ty, scale });
  }, [viewBox, containerRef, updateTransform]);

  /** Subscribe to transform changes (for Minimap etc.) */
  const subscribeTransform = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  return {
    transformRef,
    updateTransform,
    applyZoomBy,
    applyZoomToFit,
    applyZoomToPercent,
    applyZoomToBBox,
    subscribeTransform,
  };
}
