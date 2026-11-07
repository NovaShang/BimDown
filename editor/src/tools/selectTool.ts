import type { CanonicalElement, PointElement } from '../model/elements.ts';
import type { ToolHandler, ToolContext } from './types.ts';
import { snapPoint } from '../utils/snap.ts';
import { toSelectionId, toElementId, toLevelId } from '../model/ids.ts';
import { getProjectUnits } from '../utils/units.ts';
import { isBackgroundDiscipline } from '../state/selectors.ts';
import { tryStartPortDrag, updatePortDrag, finishPortDrag, isPortDragActive } from './portDragTool.ts';
import { portRefTargetsHost } from '../utils/portRef.ts';
import { expandSelectionForCoMove, collectCascadeBranches } from '../model/mepRun.ts';
import { findWallJoins, joinAffectedIds, type WallJoin } from '../geometry/wallJoins.ts';

/** Minimum drag distance (px) before a move starts */
const MOVE_THRESHOLD = 3;

const gesture = {
  isDragging: false,
  isMoving: false,
  isMarquee: false,
  /** True once a marquee gesture has dragged past the move threshold. Lets
   *  pointerup tell a real box-select from a bare click on empty space. */
  marqueeMoved: false,
  startScreen: { x: 0, y: 0 },
  startSvg: { x: 0, y: 0 },
  clickedId: null as string | null,
  beforeSnapshot: null as Map<string, CanonicalElement | null> | null,
  accumulatedDx: 0,
  accumulatedDy: 0,
  moveAnchor: null as { x: number; y: number } | null,
  /** Raw ids the move dispatches actually translate. Computed at drag-start
   *  from the selection by walking collinear MEP runs (see mepRun.ts). */
  moveIds: null as string[] | null,
  /** Wall joins snapshotted at drag start so walls met mid-drag aren't picked up. */
  wallJoins: null as WallJoin[] | null,
  reset() {
    this.isDragging = false;
    this.isMoving = false;
    this.isMarquee = false;
    this.marqueeMoved = false;
    this.clickedId = null;
    this.beforeSnapshot = null;
    this.accumulatedDx = 0;
    this.accumulatedDy = 0;
    this.moveAnchor = null;
    this.moveIds = null;
    this.wallJoins = null;
  },
};

/** Last pointer position over the canvas (Tab cycles what lies under it). */
const lastPointer = { x: NaN, y: NaN };
const tabCycle = { key: '', index: -1 };

/**
 * Tab / Shift+Tab: select, one at a time, the elements stacked under the
 * pointer (a wall under a room, a door in a wall, a member of a group).
 */
function cycleUnderPointer(ctx: ToolContext, back: boolean): boolean {
  if (!Number.isFinite(lastPointer.x) || typeof document === 'undefined') return false;
  const state = ctx.getState();
  const ids: string[] = [];
  for (const node of document.elementsFromPoint(lastPointer.x, lastPointer.y)) {
    const sid = ctx.findElementId(node);
    if (!sid || ids.includes(sid)) continue;
    const el = state.document?.elements.get(toElementId(sid));
    if (!el || el.tableName === 'connector' || el.tableName === 'model_group') continue;
    ids.push(sid);
  }
  if (ids.length === 0) return false;
  const key = ids.join('|');
  if (tabCycle.key !== key) { tabCycle.key = key; tabCycle.index = -1; }
  tabCycle.index = (tabCycle.index + (back ? -1 : 1) + ids.length) % ids.length;
  const pick = ids[tabCycle.index];
  ctx.dispatch({ type: 'SET_HOVER', id: pick });
  ctx.dispatch({ type: 'SELECT', ids: [pick], exact: true });
  return true;
}

export const selectTool: ToolHandler = {
  cursor: 'default',

  onKeyDown(ctx: ToolContext, e: KeyboardEvent) {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!cycleUnderPointer(ctx, e.shiftKey)) return false;
    e.preventDefault();
    return true;
  },

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

    // Connector clicks: ports are pure derivatives of their host
    // (host position + local offset). They never participate in selection
    // or drag directly. Three outcomes:
    //   - Open port + port-drag can start → portDragTool takes the gesture
    //     (smart MEP routing); we suppress default handling.
    //   - Otherwise (already-connected, or port-drag failed to start) →
    //     rewire the click to the host equipment / terminal / fitting so
    //     dragging moves the whole assembly. The connector itself never
    //     ends up in the selection.
    if (gesture.clickedId) {
      const docState = ctx.getState();
      // findElementId returns a level-prefixed selection id ("lv-1:cn-1");
      // document.elements is keyed by raw id ("cn-1"). Strip before lookup.
      const rawClickedId = toElementId(gesture.clickedId);
      const clickedEl = docState.document?.elements.get(rawClickedId);
      if (clickedEl?.tableName === 'connector') {
        if (
          isPortOpen(clickedEl, docState.document?.elements) &&
          tryStartPortDrag(ctx, e, rawClickedId)
        ) {
          gesture.clickedId = null; // suppress default click handling
          gesture.isDragging = false;
          return;
        }
        // Rewire to the host so dragging moves the whole assembly. Preserve
        // the original selection-id prefix so SELECT / move stay consistent.
        const hostEl = resolveConnectorHost(clickedEl, docState.document?.elements);
        if (hostEl) {
          const levelId = toLevelId(gesture.clickedId);
          gesture.clickedId = levelId ? toSelectionId(levelId, hostEl.id) : hostEl.id;
        } else {
          gesture.clickedId = null;
        }
      }
    }

    if (gesture.clickedId) {
      // Selection is committed on pointer-up (a completed click), not on
      // press — see onPointerUp. Pressing only arms the gesture so a
      // subsequent drag can move the element (onPointerMove selects it when
      // the move actually starts).
    } else {
      // Clicking on empty space. Don't clear the selection yet — a bare click
      // clears on release (onPointerUp); a drag from here becomes a marquee.
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
    // Port-drag gesture takes precedence — it captured the pointer on its
    // pointerdown branch, so we must keep feeding it move events even though
    // the select-tool's own gesture state is reset.
    if (isPortDragActive()) {
      updatePortDrag(ctx, e);
      return;
    }
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    if (!gesture.isDragging) {
      // Hover detection
      // TODO: hover temporarily disabled for performance testing
      return;
    }

    if (gesture.isMarquee) {
      const rect = ctx.containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      if (
        Math.abs(curX - gesture.startScreen.x) > MOVE_THRESHOLD ||
        Math.abs(curY - gesture.startScreen.y) > MOVE_THRESHOLD
      ) {
        gesture.marqueeMoved = true;
      }
      ctx.dispatch({
        type: 'SET_MARQUEE',
        marquee: {
          x1: gesture.startScreen.x,
          y1: gesture.startScreen.y,
          x2: curX,
          y2: curY,
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
        const freshState = ctx.getState();
        const elements = freshState.document?.elements ?? new Map<string, CanonicalElement>();

        // Expand each selected MEP pipe to its full collinear run (plus the
        // passive mep_nodes that join the run's segments). The expanded set
        // is what MOVE_ELEMENTS actually translates so a "drag" on any
        // single segment feels like sliding the whole logical pipe.
        const selectedRaw = Array.from(freshState.selectedIds).map(toElementId);
        const expanded = expandSelectionForCoMove(elements, selectedRaw);
        gesture.moveIds = [...expanded];

        // Snapshot every id that the move + reducer cascade may touch, so
        // the COMMIT_PREVIEW history entry covers them all:
        //   - the move set itself (will be translated whole)
        //   - branches the cascade will partial-move at our passive nodes
        //   - hosted children (doors/windows in a moved wall) the host cascade moves
        const cascadeBranches = collectCascadeBranches(elements, expanded);
        gesture.beforeSnapshot = new Map();
        for (const id of expanded) {
          const el = elements.get(id);
          if (el) gesture.beforeSnapshot.set(el.id, el);
        }
        for (const id of cascadeBranches) {
          const el = elements.get(id);
          if (el) gesture.beforeSnapshot.set(el.id, el);
        }
        // Hosted elements (e.g. doors/windows embedded in a wall) are cascade-
        // moved by the MOVE_ELEMENTS reducer but aren't part of the move set or
        // MEP branches, so they'd be missing from the undo command. Mirror the
        // reducer's host cascade here so undo restores them with the host.
        const movedIdSet = new Set(expanded);
        for (const el of elements.values()) {
          if (el.hostId && movedIdSet.has(el.hostId) && !gesture.beforeSnapshot.has(el.id)) {
            gesture.beforeSnapshot.set(el.id, el);
          }
        }
        // Walls joined to the moved ones follow them (corners, tees); record
        // them and their doors for undo.
        gesture.wallJoins = findWallJoins(elements, expanded);
        for (const id of joinAffectedIds(elements, expanded, gesture.wallJoins)) {
          const el = elements.get(id);
          if (el && !gesture.beforeSnapshot.has(id)) gesture.beforeSnapshot.set(id, el);
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
            // Exclude the elements being dragged so the snap algorithm doesn't
            // try to align them to their own endpoints / centers. selectedIds
            // carry the `level:` prefix; collectTargets keys are raw ids — strip
            // the prefix so the exclusion actually matches.
            const excludeRawIds = new Set<string>();
            state.selectedIds.forEach(id => excludeRawIds.add(toElementId(id)));
            const snap = snapPoint(anchorTarget, ctx.screenToSvg, state.document?.elements, excludeRawIds, undefined, undefined, state.grids, undefined, undefined, getProjectUnits(state), state.disabledSnapTypes);
            ctx.setSnap(snap.snapX || snap.snapY ? snap : null);

            const snappedDx = snap.point.x - gesture.moveAnchor.x;
            const snappedDy = snap.point.y - gesture.moveAnchor.y;

            // Dispatch incremental move
            const incrementDx = snappedDx - gesture.accumulatedDx;
            const incrementDy = snappedDy - gesture.accumulatedDy;
            gesture.accumulatedDx = snappedDx;
            gesture.accumulatedDy = snappedDy;

            const moveIds = gesture.moveIds ?? Array.from(state.selectedIds);
            ctx.dispatch({
              type: 'MOVE_ELEMENTS',
              ids: moveIds,
              dx: incrementDx,
              dy: incrementDy,
              preview: true,
              wallJoins: gesture.wallJoins ?? undefined,
            });
          } else {
            const svgDx = currentSvg.x - gesture.startSvg.x;
            const svgDy = currentSvg.y - gesture.startSvg.y;
            gesture.startSvg = currentSvg;
            const state = ctx.getState();
            const moveIds = gesture.moveIds ?? Array.from(state.selectedIds);
            ctx.dispatch({
              type: 'MOVE_ELEMENTS',
              ids: moveIds,
              dx: svgDx,
              dy: svgDy,
              preview: true,
              wallJoins: gesture.wallJoins ?? undefined,
            });
          }
        }
      }
    }
  },

  onPointerUp(ctx: ToolContext, e: React.PointerEvent) {
    if (isPortDragActive()) {
      finishPortDrag(ctx);
      ctx.setSnap(null);
      return;
    }
    if (gesture.isMarquee) {
      if (gesture.marqueeMoved) {
        // A real box-select: pick what's inside the rect.
        const state = ctx.getState();
        const container = ctx.containerRef.current;
        if (container && state.drawingState === null) {
          finishMarquee(ctx, e);
        }
      } else if (!e.shiftKey) {
        // Bare click on empty space → clear the selection on release.
        ctx.dispatch({ type: 'CLEAR_SELECTION' });
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
      // Completed click on an element (press + release, no drag) — this is
      // where selection commits.
      if (e.shiftKey) {
        ctx.dispatch({ type: 'SELECT', ids: [gesture.clickedId], additive: true });
      } else {
        ctx.dispatch({ type: 'SELECT', ids: [gesture.clickedId] });
      }
    }

    gesture.reset();
    ctx.setSnap(null);
  },
};

/** Resolve a connector's host element (equipment / terminal / mep_node) by
 *  scanning the elements map. Accepts prefixed and unprefixed host_id values. */
function resolveConnectorHost(
  conn: CanonicalElement,
  elements: ReadonlyMap<string, CanonicalElement> | undefined,
): CanonicalElement | null {
  if (!elements) return null;
  if (conn.geometry !== 'point') return null;
  const p = conn as PointElement;
  const hostRaw = p.hostId || p.attrs.host_id || '';
  if (!hostRaw) return null;
  const direct = elements.get(hostRaw);
  if (direct) return direct;
  for (const el of elements.values()) {
    const colon = el.id.indexOf(':');
    if (colon >= 0 && el.id.substring(colon + 1) === hostRaw) return el;
  }
  return null;
}

/** Is this connector free (no pipe references its host:port pair)? */
function isPortOpen(
  conn: CanonicalElement,
  elements: ReadonlyMap<string, CanonicalElement> | undefined,
): boolean {
  if (!elements || conn.geometry !== 'point') return true;
  const p = conn as PointElement;
  const portName = (p.attrs.name || '').trim();
  const host = resolveConnectorHost(conn, elements);
  if (!host) return true;
  const target = portName ? `${host.id}:${portName}` : host.id;
  const altHost = host.id.includes(':') ? host.id.substring(host.id.indexOf(':') + 1) : host.id;
  const altTarget = portName ? `${altHost}:${portName}` : altHost;
  for (const el of elements.values()) {
    if (el.tableName !== 'duct' && el.tableName !== 'pipe' &&
        el.tableName !== 'conduit' && el.tableName !== 'cable_tray') continue;
    if (el.attrs.from === target || el.attrs.to === target) return false;
    if (el.attrs.from === altTarget || el.attrs.to === altTarget) return false;
    if (!portName) {
      // Bare-host references; check both forms via portRefTargetsHost.
      if (portRefTargetsHost(el.attrs.from, host.id) || portRefTargetsHost(el.attrs.to, host.id)) return false;
    }
  }
  return true;
}

/** Get an anchor point from snapshot elements (use first element's primary point) */
function getElementAnchor(snapshot: Map<string, CanonicalElement | null> | null): { x: number; y: number } | null {
  if (!snapshot) return null;
  for (const el of snapshot.values()) {
    if (!el) continue;
    if (el.geometry === 'line' || el.geometry === 'spatial_line') return { x: el.start.x, y: el.start.y };
    if (el.geometry === 'point') return { x: el.position.x, y: el.position.y };
    if (el.geometry === 'polygon' && el.vertices.length > 0) return { x: el.vertices[0].x, y: el.vertices[0].y };
  }
  return null;
}

export interface ScreenRect { x: number; y: number; w: number; h: number }

/**
 * Marquee rule (Revit / AutoCAD): dragged left → right is a window — only
 * elements entirely inside are taken; right → left is crossing — anything
 * the box touches. `pts` are the element's extreme points on screen.
 */
export function marqueeHits(window: boolean, pts: readonly { x: number; y: number }[], rect: ScreenRect): boolean {
  if (pts.length === 0) return false;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (window) return x0 >= rect.x && x1 <= rect.x + rect.w && y0 >= rect.y && y1 <= rect.y + rect.h;
  return x0 < rect.x + rect.w && x1 > rect.x && y0 < rect.y + rect.h && y1 > rect.y;
}

/** Model-space extreme points of an element (outline, line ends, point footprint). */
function modelExtent(el: import('../model/elements.ts').CanonicalElement): { x: number; y: number }[] {
  if (el.geometry === 'polygon') return el.vertices;
  if (el.geometry === 'line' || el.geometry === 'spatial_line') return [el.start, el.end];
  const hw = (el.width || 0) / 2, hh = (el.height || el.width || 0) / 2;
  return [{ x: el.position.x - hw, y: el.position.y - hh }, { x: el.position.x + hw, y: el.position.y + hh }];
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
  // Left → right: window (entirely inside); right → left: crossing.
  const windowMode = _e.clientX - containerRect.left >= gesture.startScreen.x;

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

  const state = ctx.getState();
  const docElements = state.document?.elements;

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

      const rawId = el.getAttribute('data-id');
      if (!rawId) continue;
      const elemId = toElementId(rawId);
      const canonical = docElements?.get(elemId);
      // Window mode tests the element's own geometry (its tag text may stick out of the box).
      const toScreen = (p: { x: number; y: number }) => {
        const q = svg.createSVGPoint();
        q.x = p.x; q.y = p.y;
        const s = q.matrixTransform(ctm);
        return { x: s.x - containerRect.left, y: s.y - containerRect.top };
      };
      const pts = windowMode && canonical
        ? modelExtent(canonical).map(toScreen)
        : [{ x: screenPt1.x - containerRect.left, y: screenPt1.y - containerRect.top }, { x: screenPt2.x - containerRect.left, y: screenPt2.y - containerRect.top }];

      if (marqueeHits(windowMode, pts, marqueeRect)) {
        if (canonical && isBackgroundDiscipline(canonical.discipline, state.activeDiscipline, canonical.tableName)) continue;
        // Connectors are pure derivatives of their host — not selectable.
        if (canonical?.tableName === 'connector') continue;
        ids.add(state.currentLevel ? toSelectionId(state.currentLevel, rawId) : rawId);
      }
    } catch {
      // getBBox can throw for hidden elements
    }
  }

  if (ids.size > 0) {
    ctx.dispatch({ type: 'SELECT', ids: Array.from(ids) });
  }
}
