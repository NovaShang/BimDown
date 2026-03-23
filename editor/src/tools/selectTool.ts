import type { CanonicalElement } from '../model/elements.ts';
import type { ToolHandler, ToolContext } from './types.ts';
import { snapPoint } from '../utils/snap.ts';

/** Minimum drag distance (px) before a move starts */
const MOVE_THRESHOLD = 3;

const gesture = {
  isDragging: false,
  isMoving: false,
  isMarquee: false,
  startScreen: { x: 0, y: 0 },
  startSvg: { x: 0, y: 0 },
  clickedId: null as string | null,
  beforeSnapshot: null as Map<string, CanonicalElement | null> | null,
  accumulatedDx: 0,
  accumulatedDy: 0,
  moveAnchor: null as { x: number; y: number } | null,
  reset() {
    this.isDragging = false;
    this.isMoving = false;
    this.isMarquee = false;
    this.clickedId = null;
    this.beforeSnapshot = null;
    this.accumulatedDx = 0;
    this.accumulatedDy = 0;
    this.moveAnchor = null;
  },
};

export const selectTool: ToolHandler = {
  cursor: 'default',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;

    const rect = ctx.containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    gesture.reset();
    gesture.isDragging = true;
    gesture.startScreen = { x: e.clientX, y: e.clientY };
    gesture.clickedId = ctx.findElementId(e.target);

    const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
    gesture.startSvg = svgPt || { x: 0, y: 0 };

    if (gesture.clickedId) {
      const state = ctx.getState();
      // If clicking an unselected element without shift, select it immediately
      if (!e.shiftKey && !state.selectedIds.has(gesture.clickedId)) {
        ctx.dispatch({ type: 'SELECT', ids: [gesture.clickedId] });
      }
    } else {
      // Clicking on empty space
      if (!e.shiftKey) {
        ctx.dispatch({ type: 'CLEAR_SELECTION' });
      }
      // Prepare for marquee
      gesture.isMarquee = true;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      gesture.startScreen = { x: sx, y: sy };
      ctx.dispatch({ type: 'SET_MARQUEE', marquee: { x1: sx, y1: sy, x2: sx, y2: sy } });
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (!gesture.isDragging) {
      // Hover detection
      const elementId = ctx.findElementId(e.target);
      const state = ctx.getState();
      if (elementId !== state.hoveredId) {
        ctx.dispatch({ type: 'SET_HOVER', id: elementId });
      }
      return;
    }

    if (gesture.isMarquee) {
      const rect = ctx.containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      ctx.dispatch({
        type: 'SET_MARQUEE',
        marquee: {
          x1: gesture.startScreen.x,
          y1: gesture.startScreen.y,
          x2: e.clientX - rect.left,
          y2: e.clientY - rect.top,
        },
      });
      return;
    }

    // Element drag → move
    if (gesture.clickedId) {
      const dx = e.clientX - gesture.startScreen.x;
      const dy = e.clientY - gesture.startScreen.y;

      if (!gesture.isMoving && (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD)) {
        gesture.isMoving = true;
        // If the clicked element wasn't selected, select it now
        const state = ctx.getState();
        if (!state.selectedIds.has(gesture.clickedId)) {
          ctx.dispatch({ type: 'SELECT', ids: [gesture.clickedId] });
        }
        // Snapshot elements before move starts (for single undo entry)
        const freshState = ctx.getState();
        gesture.beforeSnapshot = new Map();
        for (const id of freshState.selectedIds) {
          const el = freshState.document?.elements.get(id);
          if (el) gesture.beforeSnapshot.set(id, el);
        }
        // Compute move anchor from the first selected element
        gesture.moveAnchor = getElementAnchor(gesture.beforeSnapshot);
      }

      if (gesture.isMoving) {
        const currentSvg = ctx.screenToSvg(e.clientX, e.clientY);
        if (currentSvg) {
          const rawDx = currentSvg.x - gesture.startSvg.x;
          const rawDy = currentSvg.y - gesture.startSvg.y;

          if (gesture.moveAnchor) {
            // Snap the anchor point's would-be position
            const anchorTarget = { x: gesture.moveAnchor.x + rawDx, y: gesture.moveAnchor.y + rawDy };
            const state = ctx.getState();
            const snap = snapPoint(anchorTarget, ctx.screenToSvg, state.document?.elements, state.selectedIds, undefined, undefined, state.grids);
            ctx.setSnap(snap.snapX || snap.snapY ? snap : null);

            const snappedDx = snap.point.x - gesture.moveAnchor.x;
            const snappedDy = snap.point.y - gesture.moveAnchor.y;

            // Dispatch incremental move
            const incrementDx = snappedDx - gesture.accumulatedDx;
            const incrementDy = snappedDy - gesture.accumulatedDy;
            gesture.accumulatedDx = snappedDx;
            gesture.accumulatedDy = snappedDy;

            ctx.dispatch({
              type: 'MOVE_ELEMENTS',
              ids: Array.from(state.selectedIds),
              dx: incrementDx,
              dy: incrementDy,
              preview: true,
            });
          } else {
            const svgDx = currentSvg.x - gesture.startSvg.x;
            const svgDy = currentSvg.y - gesture.startSvg.y;
            gesture.startSvg = currentSvg;
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
    }
  },

  onPointerUp(ctx: ToolContext, e: React.PointerEvent) {
    if (gesture.isMarquee) {
      // Finalize marquee selection
      const state = ctx.getState();
      const container = ctx.containerRef.current;
      if (container && state.drawingState === null) {
        finishMarquee(ctx, e);
      }
      ctx.dispatch({ type: 'SET_MARQUEE', marquee: null });
    } else if (gesture.clickedId && gesture.isMoving && gesture.beforeSnapshot) {
      // Commit move: build after snapshot from current state
      const afterState = ctx.getState();
      const after = new Map<string, CanonicalElement | null>();
      for (const [id] of gesture.beforeSnapshot) {
        const el = afterState.document?.elements.get(id);
        after.set(id, el ?? null);
      }
      ctx.dispatch({ type: 'COMMIT_PREVIEW', description: 'Move elements', before: gesture.beforeSnapshot, after });
    } else if (gesture.clickedId && !gesture.isMoving) {
      // Simple click (no drag) — handle shift-toggle
      if (e.shiftKey) {
        ctx.dispatch({ type: 'SELECT', ids: [gesture.clickedId], additive: true });
      }
      // Non-shift already handled in onPointerDown
    }

    gesture.reset();
    ctx.setSnap(null);
  },
};

/** Get an anchor point from snapshot elements (use first element's primary point) */
function getElementAnchor(snapshot: Map<string, CanonicalElement | null> | null): { x: number; y: number } | null {
  if (!snapshot) return null;
  for (const el of snapshot.values()) {
    if (!el) continue;
    if (el.geometry === 'line') return { x: el.start.x, y: el.start.y };
    if (el.geometry === 'point') return { x: el.position.x, y: el.position.y };
    if (el.geometry === 'polygon' && el.vertices.length > 0) return { x: el.vertices[0].x, y: el.vertices[0].y };
  }
  return null;
}

function finishMarquee(ctx: ToolContext, _e: React.PointerEvent) {
  const container = ctx.containerRef.current;
  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const marqueeRect = {
    x: Math.min(gesture.startScreen.x, _e.clientX - containerRect.left),
    y: Math.min(gesture.startScreen.y, _e.clientY - containerRect.top),
    w: Math.abs((_e.clientX - containerRect.left) - gesture.startScreen.x),
    h: Math.abs((_e.clientY - containerRect.top) - gesture.startScreen.y),
  };

  if (marqueeRect.w < 5 && marqueeRect.h < 5) return;

  // 3D mode: use resolveMarquee callback
  if (ctx.resolveMarquee) {
    const ids = ctx.resolveMarquee(marqueeRect, containerRect);
    if (ids.length > 0) {
      ctx.dispatch({ type: 'SELECT', ids });
    }
    return;
  }

  // 2D mode: use SVG DOM
  const svg = ctx.svgRef.current;
  if (!svg) return;

  const ids = new Set<string>();
  const elements = svg.querySelectorAll('[data-id]');
  for (const el of elements) {
    try {
      const bbox = (el as SVGGraphicsElement).getBBox();
      const ctm = (el as SVGGraphicsElement).getScreenCTM();
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
