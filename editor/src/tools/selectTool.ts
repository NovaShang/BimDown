import type { CanonicalElement } from '../model/elements.ts';
import type { ToolHandler, ToolContext } from './types.ts';

/** Minimum drag distance (px) before a move starts */
const MOVE_THRESHOLD = 3;

let isDragging = false;
let isMoving = false;
let isMarquee = false;
let startScreen = { x: 0, y: 0 };
let startSvg = { x: 0, y: 0 };
let clickedId: string | null = null;
/** Snapshots of selected elements at drag start, for single undo entry */
let beforeSnapshot: Map<string, CanonicalElement | null> | null = null;

export const selectTool: ToolHandler = {
  cursor: 'default',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const rect = ctx.containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    isDragging = true;
    isMoving = false;
    isMarquee = false;
    startScreen = { x: e.clientX, y: e.clientY };
    clickedId = ctx.findElementId(e.target);

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    startSvg = svgPt || { x: 0, y: 0 };

    if (clickedId) {
      const state = ctx.getState();
      // If clicking an unselected element without shift, select it immediately
      if (!e.shiftKey && !state.selectedIds.has(clickedId)) {
        ctx.dispatch({ type: 'SELECT', ids: [clickedId] });
      }
    } else {
      // Clicking on empty space
      if (!e.shiftKey) {
        ctx.dispatch({ type: 'CLEAR_SELECTION' });
      }
      // Prepare for marquee
      isMarquee = true;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      startScreen = { x: sx, y: sy };
      ctx.dispatch({ type: 'SET_MARQUEE', marquee: { x1: sx, y1: sy, x2: sx, y2: sy } });
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (!isDragging) {
      // Hover detection
      const elementId = ctx.findElementId(e.target);
      const state = ctx.getState();
      if (elementId !== state.hoveredId) {
        ctx.dispatch({ type: 'SET_HOVER', id: elementId });
      }
      return;
    }

    if (isMarquee) {
      const rect = ctx.containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      ctx.dispatch({
        type: 'SET_MARQUEE',
        marquee: {
          x1: startScreen.x,
          y1: startScreen.y,
          x2: e.clientX - rect.left,
          y2: e.clientY - rect.top,
        },
      });
      return;
    }

    // Element drag → move
    if (clickedId) {
      const dx = e.clientX - startScreen.x;
      const dy = e.clientY - startScreen.y;

      if (!isMoving && (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD)) {
        isMoving = true;
        // If the clicked element wasn't selected, select it now
        const state = ctx.getState();
        if (!state.selectedIds.has(clickedId)) {
          ctx.dispatch({ type: 'SELECT', ids: [clickedId] });
        }
        // Snapshot elements before move starts (for single undo entry)
        const freshState = ctx.getState();
        beforeSnapshot = new Map();
        for (const id of freshState.selectedIds) {
          const el = freshState.document?.elements.get(id);
          if (el) beforeSnapshot.set(id, el);
        }
      }

      if (isMoving) {
        const currentSvg = ctx.screenToSvg(e.clientX, e.clientY);
        if (currentSvg) {
          const svgDx = currentSvg.x - startSvg.x;
          const svgDy = currentSvg.y - startSvg.y;
          startSvg = currentSvg;
          const state = ctx.getState();
          ctx.dispatch({
            type: 'MOVE_ELEMENTS',
            ids: Array.from(state.selectedIds),
            dx: svgDx,
            dy: svgDy,
            preview: true,
          });
        }
      }
    }
  },

  onPointerUp(ctx: ToolContext, e: React.PointerEvent) {
    if (isMarquee) {
      // Finalize marquee selection
      const state = ctx.getState();
      const svg = ctx.svgRef.current;
      const container = ctx.containerRef.current;
      if (svg && container && state.drawingState === null) {
        // Read marquee from a fresh getState call — the marquee may have been updated
        finishMarquee(ctx, e);
      }
      ctx.dispatch({ type: 'SET_MARQUEE', marquee: null });
    } else if (clickedId && isMoving && beforeSnapshot) {
      // Commit move: build after snapshot from current state
      const afterState = ctx.getState();
      const after = new Map<string, CanonicalElement | null>();
      for (const [id] of beforeSnapshot) {
        const el = afterState.document?.elements.get(id);
        after.set(id, el ?? null);
      }
      ctx.dispatch({ type: 'COMMIT_PREVIEW', description: 'Move elements', before: beforeSnapshot, after });
    } else if (clickedId && !isMoving) {
      // Simple click (no drag) — handle shift-toggle
      if (e.shiftKey) {
        ctx.dispatch({ type: 'SELECT', ids: [clickedId], additive: true });
      }
      // Non-shift already handled in onPointerDown
    }

    isDragging = false;
    isMoving = false;
    isMarquee = false;
    clickedId = null;
    beforeSnapshot = null;
  },
};

function finishMarquee(ctx: ToolContext, _e: React.PointerEvent) {
  const svg = ctx.svgRef.current;
  const container = ctx.containerRef.current;
  if (!svg || !container) return;

  const containerRect = container.getBoundingClientRect();
  // Re-read marquee coordinates from the DOM state
  // We stored them in startScreen but need the current mouse position too
  // The marquee state is in the reducer, but we can compute from screen coords
  const marqueeRect = {
    x: Math.min(startScreen.x, _e.clientX - containerRect.left),
    y: Math.min(startScreen.y, _e.clientY - containerRect.top),
    w: Math.abs((_e.clientX - containerRect.left) - startScreen.x),
    h: Math.abs((_e.clientY - containerRect.top) - startScreen.y),
  };

  if (marqueeRect.w < 5 && marqueeRect.h < 5) return;

  const ids = new Set<string>();
  const elements = svg.querySelectorAll('[data-id]');
  for (const el of elements) {
    try {
      const bbox = (el as SVGGraphicsElement).getBBox();
      const ctm = (el as SVGGraphicsElement).getCTM();
      if (!ctm) continue;

      const pt1 = svg.createSVGPoint();
      pt1.x = bbox.x;
      pt1.y = bbox.y;
      const screenPt1 = pt1.matrixTransform(ctm);

      const pt2 = svg.createSVGPoint();
      pt2.x = bbox.x + bbox.width;
      pt2.y = bbox.y + bbox.height;
      const screenPt2 = pt2.matrixTransform(ctm);

      const elRect = {
        x: Math.min(screenPt1.x, screenPt2.x) - containerRect.left,
        y: Math.min(screenPt1.y, screenPt2.y) - containerRect.top,
        w: Math.abs(screenPt2.x - screenPt1.x),
        h: Math.abs(screenPt2.y - screenPt1.y),
      };

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

  if (ids.size > 0) {
    ctx.dispatch({ type: 'SELECT', ids: Array.from(ids) });
  }
}
