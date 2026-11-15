/**
 * Port-drag gesture.
 *
 * Activated when the user mouses-down on an open MEP connector (a `connector`
 * row whose host has no pipe attached to it). The gesture takes over until
 * pointer-up; on commit it materialises a multi-segment orthogonal route as
 * pipe rows + intermediate elbow mep_node rows, and wires `from` / `to` to
 * the source / target port refs.
 *
 * This module exposes a small state machine (start / move / up / cancel /
 * isActive / preview) that the `select` tool delegates to when its pointer-
 * down lands on a connector. It is intentionally NOT a top-level `Tool` —
 * users don't pick "port drag" from the toolbar; they just grab a port.
 */
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import type { ToolContext } from './types.ts';
import { gatherConnectorSnapPoints } from '../utils/connectorSnap.ts';
import { orthoRoute } from '../utils/orthoRoute.ts';
import { continueRoute, endRoute, isGravitySystem, rememberedRouteAttrs, startRoute, DEFAULT_DRAIN_SLOPE, SLOPE_KEY, type RouteApi } from '../mep/routeTool.ts';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import type { DrawingState } from '../state/editorTypes.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { findPipeBodyHit, type PipeBodyHit } from '../utils/pipeBodyHit.ts';

interface PortDragState {
  /** True while the gesture is in flight. */
  active: boolean;
  /** Origin port-ref ("host_id:port_name" or bare "host_id"). */
  fromRef: string;
  /** World-space origin point (host.origin + R(rot)·offset). */
  origin: Point;
  /** Outward direction of the source port in world coords. */
  outwardDir: { x: number; y: number };
  /** Current cursor in world coords. */
  cursor: Point;
  /** Snapped target port-ref (set when cursor lands on a matching connector). */
  targetRef: string | null;
  /** Snapped target pipe body (set when cursor lands on a matching pipe). A
   *  pipe hit is always lower priority than a connector hit. */
  pipeHit: PipeBodyHit | null;
  /** Material parameters captured from the source port. */
  systemType: string;
  shape: string;
  sizeX: string;
  sizeY: string;
  /** Pipe table (pipe / duct / conduit / cable_tray) derived from the port's
   *  domain attribute. Defaults to "pipe" when unset. */
  pipeTable: string;
  /** Z elevation for the run. */
  z: number;
  /** Level id (for default-attrs lookup). */
  levelId: string;
}

const state: PortDragState = {
  active: false,
  fromRef: '',
  origin: { x: 0, y: 0 },
  outwardDir: { x: 1, y: 0 },
  cursor: { x: 0, y: 0 },
  targetRef: null,
  pipeHit: null,
  systemType: '',
  shape: '',
  sizeX: '',
  sizeY: '',
  pipeTable: 'pipe',
  z: 0,
  levelId: '',
};

/** Subscribers (e.g. the overlay layer) get notified on every state change so
 *  the React tree can re-render the ghost polyline without leaking the
 *  internal gesture state. */
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribePortDrag(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function isPortDragActive(): boolean {
  return state.active;
}

/** Read-only snapshot for overlay rendering. Returns null when inactive. */
export function getPortDragSnapshot(): {
  origin: Point;
  cursor: Point;
  targetRef: string | null;
  pipeHitPoint: Point | null;
  outwardDir: { x: number; y: number };
} | null {
  if (!state.active) return null;
  return {
    origin: { ...state.origin },
    cursor: { ...state.cursor },
    targetRef: state.targetRef,
    pipeHitPoint: state.pipeHit ? { ...state.pipeHit.point } : null,
    outwardDir: { ...state.outwardDir },
  };
}

// ── Helpers ──

function rotate2D(x: number, y: number, deg: number): { x: number; y: number } {
  if (!deg) return { x, y };
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * x - s * y, y: s * x + c * y };
}

function findHostById(id: string, elements: ReadonlyMap<string, CanonicalElement>): CanonicalElement | null {
  const direct = elements.get(id);
  if (direct) return direct;
  for (const el of elements.values()) {
    const colon = el.id.indexOf(':');
    if (colon >= 0 && el.id.substring(colon + 1) === id) return el;
  }
  return null;
}

function pipeTableForDomain(domain: string): string {
  switch (domain) {
    case 'hvac': return 'duct';
    case 'electrical': return 'conduit';
    case 'cable_tray_conduit': return 'cable_tray';
    case 'piping':
    default: return 'pipe';
  }
}

// ── Public state-machine ──

/** Try to start a port-drag gesture from a pointer-down event.
 *  Returns true if the event was consumed (i.e. the click landed on an open
 *  connector and the gesture is now active). False if the click should fall
 *  through to the normal tool handler. */
export function tryStartPortDrag(ctx: ToolContext, e: React.PointerEvent, connectorId: string): boolean {
  const snap = ctx.getState();
  const doc = snap.document;
  if (!doc) return false;
  const conn = doc.elements.get(connectorId);
  if (!conn || conn.tableName !== 'connector' || conn.geometry !== 'point') return false;
  const p = conn as PointElement;

  const hostRaw = p.hostId || p.attrs.host_id || '';
  const host = findHostById(hostRaw, doc.elements);
  if (!host || host.geometry !== 'point') return false;
  const hostP = host as PointElement;

  const ox = parseFloat(p.attrs.offset_x || '0') || 0;
  const oy = parseFloat(p.attrs.offset_y || '0') || 0;
  const oz = parseFloat(p.attrs.offset_z || '0') || 0;
  const dx = parseFloat(p.attrs.dir_x || '1');
  const dy = parseFloat(p.attrs.dir_y || '0');
  const rotation = parseFloat(hostP.attrs.rotation || '0') || 0;
  const baseOffset = parseFloat(hostP.attrs.base_offset || '0') || 0;

  const localOff = rotate2D(ox, oy, rotation);
  const origin: Point = { x: hostP.position.x + localOff.x, y: hostP.position.y + localOff.y };
  const dirRot = rotate2D(isNaN(dx) ? 1 : dx, isNaN(dy) ? 0 : dy, rotation);
  const len = Math.sqrt(dirRot.x * dirRot.x + dirRot.y * dirRot.y);
  const outwardDir = len > 1e-6 ? { x: dirRot.x / len, y: dirRot.y / len } : { x: 1, y: 0 };

  const portName = (p.attrs.name || '').trim();
  const fromRef = portName ? `${host.id}:${portName}` : host.id;

  state.active = true;
  state.fromRef = fromRef;
  state.origin = origin;
  state.outwardDir = outwardDir;
  state.cursor = origin;
  state.targetRef = null;
  state.pipeHit = null;
  state.systemType = (p.attrs.system_type || '').trim();
  state.shape = (p.attrs.shape || '').trim();
  state.sizeX = (p.attrs.size_w || '').trim();
  state.sizeY = (p.attrs.size_h || '').trim();
  state.pipeTable = pipeTableForDomain((p.attrs.domain || '').trim());
  // Z = level elevation isn't on the connector directly; we use host
  // base_offset + connector offset_z. The reducer's level resolution treats
  // start_z / end_z as host-local + base_offset, matching how other MEP
  // line tools store it.
  state.z = baseOffset + oz;
  state.levelId = resolveNextLevelId(snap);

  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  notify();
  return true;
}

/** Drive the gesture forward on pointer-move. */
export function updatePortDrag(ctx: ToolContext, e: React.PointerEvent): void {
  if (!state.active) return;
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return;

  const snap = ctx.getState();
  const elements = snap.document?.elements;
  const connectorPoints = gatherConnectorSnapPoints(elements).filter(
    (cp) => cp.portRef !== state.fromRef,
  );

  // Reuse the standard snap pipeline so endpoint / connector / grid snaps
  // all behave the way the user expects.
  const snapResult = snapPoint(
    svgPt, ctx.screenToSvg, elements, undefined, state.origin, undefined,
    snap.grids, undefined, connectorPoints, getProjectUnits(snap), snap.disabledSnapTypes,
  );

  state.cursor = { x: snapResult.point.x, y: snapResult.point.y };
  state.targetRef = snapResult.connectorHit?.portRef ?? null;

  // Only look for a body hit when no connector matched — connector snaps
  // always win. Tolerance scales with the current view so the hit zone is
  // ~10px equivalent. We approximate by reusing the snap pipeline's
  // pixelSize via the cursor delta (not perfect but close enough for the
  // gesture).
  if (!state.targetRef && elements) {
    const tolerance = 0.2; // ~20cm world; refined by scale-aware overlay if needed
    state.pipeHit = findPipeBodyHit(state.cursor, elements, {
      tolerance,
      systemType: state.systemType || undefined,
    });
    if (state.pipeHit) {
      state.cursor = { ...state.pipeHit.point };
    }
  } else {
    state.pipeHit = null;
  }
  notify();
}

/** Resolve the gesture on pointer-up. Materialises a run through the MEP
 *  router (same heights, rise / drop, slope, transitions and tees as the
 *  routing tool) along an orthogonal polyline; otherwise quietly cancels. */
export function finishPortDrag(ctx: ToolContext): void {
  if (!state.active) return;
  const elements = ctx.getState().document?.elements;
  let polyline: Point[] | null = null;
  let toRef: string | undefined;

  if (state.targetRef && elements) {
    const targetCp = gatherConnectorSnapPoints(elements).find((cp) => cp.portRef === state.targetRef);
    polyline = orthoRoute(state.origin, targetCp ? targetCp.pos : state.cursor, {
      sourceDir: state.outwardDir,
      targetDir: targetCp ? { x: targetCp.dir.x, y: targetCp.dir.y } : undefined,
    });
    toRef = state.targetRef;
  } else if (state.pipeHit && elements) {
    // T-junction: the router tees into the run's body (with a rise / drop to its height).
    polyline = orthoRoute(state.origin, state.pipeHit.point, { sourceDir: state.outwardDir });
  } else {
    // Cursor on empty space: an open-ended run to where the user released.
    if (Math.hypot(state.cursor.x - state.origin.x, state.cursor.y - state.origin.y) < 0.001) { reset(); return; }
    polyline = orthoRoute(state.origin, state.cursor, { sourceDir: state.outwardDir });
  }
  if (polyline && polyline.length >= 2) routeAlong(ctx, polyline, toRef);
  reset();
}

/**
 * Drive the router (mep/routeTool.ts) along `polyline` from the source port
 * on a scratch drawing state, then create everything in one undo step.
 */
function routeAlong(ctx: ToolContext, polyline: Point[], toRef: string | undefined): void {
  const table = state.pipeTable;
  const remembered = rememberedRouteAttrs(table);
  const live = ctx.getState();
  const attrs: Record<string, string> = {
    ...getDefaultDrawingAttrs(table, live.currentLevel, live.project?.levels),
    system_type: state.systemType,
    shape: state.shape || (table === 'pipe' || table === 'conduit' ? 'round' : 'rect'),
    size_x: state.sizeX || '0.05',
    size_y: state.sizeY || state.sizeX || '0.05',
    start_z: String(state.z),
  };
  // Drainage keeps falling at the slope last used for pipes.
  if (table === 'pipe' && isGravitySystem(state.systemType)) attrs[SLOPE_KEY] = remembered[SLOPE_KEY] || String(DEFAULT_DRAIN_SLOPE);
  const scratch: { drawingAttrs: Record<string, string>; drawingState: DrawingState | null } = { drawingAttrs: attrs, drawingState: null };
  const created: CanonicalElement[] = [];
  const api: RouteApi = {
    dispatch: (a) => {
      if (a.type === 'SET_DRAWING_ATTRS') scratch.drawingAttrs = a.attrs;
      else if (a.type === 'SET_DRAWING_STATE') scratch.drawingState = a.state;
      else if (a.type === 'CREATE_ELEMENTS') created.push(...a.elements);
      else ctx.dispatch(a);
    },
    getState: () => {
      const s = ctx.getState();
      const doc = s.document;
      const elements = new Map(doc?.elements ?? []);
      for (const el of created) elements.set(el.id, el);
      return {
        ...s, document: doc ? { ...doc, elements } : doc,
        drawingTarget: { tableName: table, discipline: 'mep' },
        drawingAttrs: scratch.drawingAttrs, drawingState: scratch.drawingState,
      };
    },
  };
  startRoute(api, polyline[0], state.fromRef);
  for (let i = 1; i < polyline.length && scratch.drawingState?.points.length; i++) {
    continueRoute(api, polyline[i], i === polyline.length - 1 ? toRef : undefined);
  }
  endRoute();
  if (created.length > 0) {
    ctx.dispatch({ type: 'CREATE_ELEMENTS', elements: created, description: 'Draw run from port', selectPrimary: false });
  }
}

export function cancelPortDrag(): void {
  if (!state.active) return;
  reset();
}

function reset(): void {
  state.active = false;
  state.fromRef = '';
  state.targetRef = null;
  state.pipeHit = null;
  notify();
}
