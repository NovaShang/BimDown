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
import type { MepCurveElement } from '../utils/pipeBodyHit.ts';
import type { ToolContext } from './types.ts';
import { gatherConnectorSnapPoints } from '../utils/connectorSnap.ts';
import { orthoRoute, materialiseRoute } from '../utils/orthoRoute.ts';
import { resolveNextLevelId } from './levelUtil.ts';
import { snapPoint } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { findPipeBodyHit, type PipeBodyHit } from '../utils/pipeBodyHit.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

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
    snap.grids, undefined, connectorPoints, getProjectUnits(snap),
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

/** Resolve the gesture on pointer-up. Materialises a pipe run when the
 *  cursor landed on a valid target; otherwise quietly cancels. */
export function finishPortDrag(ctx: ToolContext): void {
  if (!state.active) return;

  const snap = ctx.getState();
  const elements = snap.document?.elements;

  // ─── Case 1: T-junction — cursor on another pipe's body ─────────────────
  if (state.pipeHit && elements && !state.targetRef) {
    // Single id-allocation pool: split-target + new-downstream + new-node +
    // every pipe / elbow that materialiseRoute is about to mint must all
    // pull from the same set so two distinct rows never share an id.
    const existingIds = new Set(elements.keys());
    const patch = buildTJunctionPatch(state.pipeHit, existingIds);
    if (patch) {
      const polyline = orthoRoute(state.origin, state.pipeHit.point, {
        sourceDir: state.outwardDir,
      });
      if (polyline.length >= 2) {
        const created = materialiseRoute(polyline, {
          tableName: state.pipeTable,
          discipline: 'mep',
          z: state.z,
          fromRef: state.fromRef,
          toRef: patch.newNodeId,
          systemType: state.systemType,
          shape: state.shape || (state.pipeTable === 'pipe' ? 'round' : 'rect'),
          sizeX: state.sizeX || '0.05',
          sizeY: state.sizeY || state.sizeX || '0.05',
          levelId: state.levelId,
        }, existingIds);

        const patches = new Map<string, CanonicalElement | null>();
        patches.set(patch.originalPipeId, patch.updatedOriginal);
        patches.set(patch.newDownstreamId, patch.newDownstream);
        patches.set(patch.newNodeId, patch.newNode);
        for (const el of created) patches.set(el.id, el);

        ctx.dispatch({
          type: 'APPLY_PATCH',
          description: 'Insert T-junction',
          patches,
        });
      }
    }
    reset();
    return;
  }

  let polyline: Point[] | null = null;
  let toRef: string | null = null;

  if (state.targetRef && elements) {
    // Determine target outward dir for orthoRoute hint.
    const targetCp = gatherConnectorSnapPoints(elements).find((cp) => cp.portRef === state.targetRef);
    polyline = orthoRoute(state.origin, state.cursor, {
      sourceDir: state.outwardDir,
      targetDir: targetCp ? { x: targetCp.dir.x, y: targetCp.dir.y } : undefined,
    });
    // Snap polyline's terminal vertex to the target port's true position.
    if (targetCp && polyline.length >= 2) {
      polyline[polyline.length - 1] = { x: targetCp.pos.x, y: targetCp.pos.y };
      // Adjust the bend to stay axis-aligned with the corrected endpoint.
      if (polyline.length === 3) {
        const firstAxis = Math.abs(polyline[1].x - polyline[0].x) > Math.abs(polyline[1].y - polyline[0].y) ? 'h' : 'v';
        polyline[1] = firstAxis === 'h'
          ? { x: polyline[2].x, y: polyline[0].y }
          : { x: polyline[0].x, y: polyline[2].y };
      }
    }
    toRef = state.targetRef;
  } else {
    // Cursor on empty space: create an open-ended pipe to where the user
    // released. Any drag at all (>= 1 mm) qualifies — the gesture itself
    // has already passed selectTool's MOVE_THRESHOLD check, so we only
    // reject the degenerate "pointer-up without a single move event" case.
    const dx = state.cursor.x - state.origin.x;
    const dy = state.cursor.y - state.origin.y;
    if (Math.hypot(dx, dy) < 0.001) {
      reset();
      return;
    }
    polyline = orthoRoute(state.origin, state.cursor, { sourceDir: state.outwardDir });
  }

  if (!polyline || polyline.length < 2) {
    reset();
    return;
  }

  const existingIds = new Set(elements?.keys() ?? []);
  const created = materialiseRoute(polyline, {
    tableName: state.pipeTable,
    discipline: 'mep',
    z: state.z,
    fromRef: state.fromRef,
    toRef,
    systemType: state.systemType,
    shape: state.shape || (state.pipeTable === 'pipe' ? 'round' : 'rect'),
    sizeX: state.sizeX || '0.05',
    sizeY: state.sizeY || state.sizeX || '0.05',
    levelId: state.levelId,
  }, existingIds);

  if (created.length > 0) {
    ctx.dispatch({
      type: 'CREATE_ELEMENTS',
      elements: created,
      description: 'Draw pipe from port',
      selectPrimary: false,
    });
  }
  reset();
}

/** Build the three-row patch that converts a pipe body hit into a T-junction.
 *  Returns null if the pipe shouldn't be split (e.g. degenerate hit). */
interface TJunctionPatch {
  originalPipeId: string;
  updatedOriginal: MepCurveElement;
  newDownstreamId: string;
  newDownstream: MepCurveElement;
  newNodeId: string;
  newNode: PointElement;
}

function buildTJunctionPatch(
  hit: PipeBodyHit,
  existingIds: Set<string>,
): TJunctionPatch | null {
  const original = hit.pipe;
  const newNodeId = generateId('mep_node', existingIds);
  existingIds.add(newNodeId);
  const newPipeId = generateId(original.tableName, existingIds);
  existingIds.add(newPipeId);

  const splitPoint = hit.point;

  // Upstream half retains the original id (so external references survive
  // the undo/redo round-trip cleanly). Its `to` is rewired to the new node.
  const isSpatial = original.geometry === 'spatial_line';
  const spatial = original as unknown as { startZ?: number; endZ?: number };
  const updatedOriginal: MepCurveElement = {
    ...original,
    end: { x: splitPoint.x, y: splitPoint.y },
    ...(isSpatial ? { endZ: spatial.startZ ?? 0 } : {}),
    attrs: { ...original.attrs, to: newNodeId },
  } as MepCurveElement;

  // Downstream half: brand-new pipe carrying the original's tail.
  const newDownstream: MepCurveElement = {
    ...original,
    id: newPipeId,
    start: { x: splitPoint.x, y: splitPoint.y },
    ...(isSpatial ? { startZ: spatial.endZ ?? 0 } : {}),
    attrs: {
      ...original.attrs,
      id: newPipeId,
      from: newNodeId,
      to: original.attrs.to ?? '',
    },
  } as MepCurveElement;

  const baseNodeAttrs = defaultAttrs('mep_node', /* level inferred from pipe row */ '');
  const newNode: PointElement = {
    id: newNodeId,
    tableName: 'mep_node',
    discipline: original.discipline,
    geometry: 'point',
    position: { x: splitPoint.x, y: splitPoint.y },
    width: 0,
    height: 0,
    attrs: {
      ...baseNodeAttrs,
      id: newNodeId,
      system_type: original.attrs.system_type ?? '',
      kind: '',
    },
  };

  return {
    originalPipeId: original.id,
    updatedOriginal,
    newDownstreamId: newPipeId,
    newDownstream,
    newNodeId,
    newNode,
  };
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
