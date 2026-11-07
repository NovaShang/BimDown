/**
 * Continuous MEP routing (duct / pipe / conduit / cable tray).
 *
 * Click, click, click: every click ends a segment and starts the next one
 * from the same point, so a run is drawn in one go; elbows, tees and
 * reducers come from the endpoint bonding in the reducer (passive nodes) and
 * draw as real fittings. Esc / right-click ends the run.
 *
 * Heights: the toolbar `Offset` (start_z) is the run's centre-line height.
 * Changing it mid-run inserts a vertical segment (rise / drop) at the current
 * point. A pipe slope (%) makes each segment fall along the drawing
 * direction and the Offset follows the run. A run that starts or ends on a
 * port, a run end or another run's body at a different height gets the
 * vertical segment it needs to really meet it (diffusers below the duct, a
 * pump nozzle, a main at another height). Starting on a port or a run takes
 * its system, size and height.
 */
import type { CanonicalElement, SpatialLineElement, PointElement, Point } from '../model/elements.ts';
import type { ToolContext, ToolStateSnapshot } from '../tools/types.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import { generateId } from '../model/ids.ts';
import { reservedIds } from './reservedIds.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { snapPoint, type SnapResult } from '../utils/snap.ts';
import { getProjectUnits } from '../utils/units.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { resolveNextLevelId } from '../tools/levelUtil.ts';
import { variantDefaults } from '../tools/variantDefaults.ts';
import { gatherConnectorSnapPoints, isMepLineTable } from '../utils/connectorSnap.ts';
import { findConnectorByPort, findHostElement, parsePortRef } from '../utils/portRef.ts';
import { findPipeBodyHit } from '../utils/pipeBodyHit.ts';
import { endZ as curveEndZ, zAt } from '../model/mepSplit.ts';

type MepCurve = SpatialLineElement;

/** Drawing-attr keys owned by the router (never persisted). */
export const SLOPE_KEY = '__slope';
const VERTICAL_MODE_KEY = '__vertical_mode';
const EPS_Z = 1e-3;
const JOIN_TOL = 0.01;

type RouteState = Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs' | 'drawingTarget' | 'drawingState' | 'grids' | 'disabledSnapTypes'>;

export interface RouteApi {
  dispatch: (a: EditorAction) => void;
  getState: () => RouteState;
}

interface Chain {
  /** Height (level-relative) of the run at the current point. */
  z: number;
  /** Typed segment length, as typed. */
  typed: string;
}

const chain: Chain = { z: NaN, typed: '' };
const listeners = new Set<() => void>();
let snapshot: { z: number; typed: string } = { z: NaN, typed: '' };
const notify = () => {
  snapshot = { z: chain.z, typed: chain.typed };
  for (const l of listeners) l();
};

export function subscribeRoute(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRouteSnapshot(): { z: number; typed: string } {
  return snapshot;
}

export function setTypedLength(text: string): void {
  chain.typed = text;
  notify();
}

export function isRouting(state: RouteState): boolean {
  return isMepLineTable(state.drawingTarget?.tableName) && (state.drawingState?.points.length ?? 0) > 0
    && state.drawingAttrs[VERTICAL_MODE_KEY] !== 'true';
}

function num(v: string | undefined, fallback = 0): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
}

/** Port info for a port ref: world position, height, outward direction (3D), system and section. */
function portInfo(ref: string, elements: ReadonlyMap<string, CanonicalElement>) {
  const p = parsePortRef(ref);
  if (!p?.portName) return null;
  const host = findHostElement(p.hostId, elements) as PointElement | null;
  const conn = findConnectorByPort(p.hostId, p.portName, elements);
  if (!host || !conn) return null;
  const rot = (num(host.attrs.rotation) * Math.PI) / 180;
  const ox = num(conn.attrs.offset_x), oy = num(conn.attrs.offset_y), oz = num(conn.attrs.offset_z);
  const dx = num(conn.attrs.dir_x, 1), dy = num(conn.attrs.dir_y), dz = num(conn.attrs.dir_z);
  return {
    at: { x: host.position.x + ox * Math.cos(rot) - oy * Math.sin(rot), y: host.position.y + ox * Math.sin(rot) + oy * Math.cos(rot) },
    z: num(host.attrs.base_offset) + oz,
    dir: { x: dx * Math.cos(rot) - dy * Math.sin(rot), y: dx * Math.sin(rot) + dy * Math.cos(rot), z: dz },
    system: (conn.attrs.system_type || '').trim(),
    shape: (conn.attrs.shape || '').trim(),
    w: (conn.attrs.size_w || '').trim(),
    h: (conn.attrs.size_h || '').trim(),
  };
}

/** A run end of the same table at `p` (excluding `excludeIds`). */
function runEndAt(p: Point, table: string, elements: ReadonlyMap<string, CanonicalElement>, exclude: Set<string>) {
  for (const el of elements.values()) {
    if (el.tableName !== table || el.geometry !== 'spatial_line' || exclude.has(el.id)) continue;
    const c = el as MepCurve;
    for (const side of ['start', 'end'] as const) {
      const q = side === 'start' ? c.start : c.end;
      if (Math.hypot(q.x - p.x, q.y - p.y) <= JOIN_TOL) return { curve: c, side, z: curveEndZ(c, side) };
    }
  }
  return null;
}

function snapAt(ctx: ToolContext, e: React.PointerEvent): SnapResult | null {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const anchor = state.drawingState?.points[0] ?? undefined;
  const connectors = gatherConnectorSnapPoints(state.document?.elements);
  return snapPoint(svgPt, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, connectors, getProjectUnits(state), state.disabledSnapTypes);
}

class Builder {
  readonly out: CanonicalElement[] = [];
  private ids: Set<string>;
  private state: RouteState;
  constructor(state: RouteState) {
    this.state = state;
    this.ids = reservedIds(state.document?.elements);
  }
  segment(a: Point, za: number, b: Point, zb: number, refs: { from?: string; to?: string } = {}): MepCurve | null {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-4 && Math.abs(zb - za) < EPS_Z) return null;
    const target = this.state.drawingTarget!;
    const id = generateId(target.tableName, this.ids);
    this.ids.add(id);
    const da = this.state.drawingAttrs;
    const attrs: Record<string, string> = {
      ...defaultAttrs(target.tableName, resolveNextLevelId(this.state)),
      ...variantDefaults(target.tableName, target.variantId),
      ...da,
      id,
      start_z: String(round(za)),
      end_z: String(round(zb)),
    };
    for (const k of Object.keys(attrs)) if (k.startsWith('__')) delete attrs[k];
    delete attrs.from; delete attrs.to;
    if (refs.from) attrs.from = refs.from;
    if (refs.to) attrs.to = refs.to;
    const el: MepCurve = {
      id, tableName: target.tableName, discipline: target.discipline, geometry: 'spatial_line',
      start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, startZ: round(za), endZ: round(zb),
      strokeWidth: resolveLineStrokeWidth(target.tableName, attrs) ?? 0.1,
      attrs,
    };
    this.out.push(el);
    return el;
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Attrs a run inherits from where it starts (port or another run). */
function inheritFrom(source: { system?: string; shape?: string; w?: string; h?: string }, table: string, da: Record<string, string>): Record<string, string> {
  const next = { ...da };
  if (source.system) next.system_type = source.system;
  if (source.w && num(source.w) > 0) next.size_x = source.w;
  if (source.shape === 'round' || source.shape === 'rect') next.shape = source.shape;
  if (source.h && num(source.h) > 0 && next.shape !== 'round') next.size_y = source.h;
  else if (next.shape === 'round' && source.w) next.size_y = source.w;
  if (table === 'pipe' || table === 'conduit') next.shape = 'round';
  return next;
}

/** First click of a run. */
export function startRoute(api: RouteApi, pt: Point, portRef: string | undefined): void {
  const state = api.getState();
  const elements = state.document?.elements;
  const table = state.drawingTarget?.tableName;
  if (!elements || !table) return;
  let da = { ...state.drawingAttrs };
  let z = num(da.start_z, 3);
  let at = pt;
  let startRef: string | undefined;
  let riserFrom: { z: number; ref: string } | null = null;

  const port = portRef ? portInfo(portRef, elements) : null;
  if (port && portRef) {
    da = inheritFrom(port, table, da);
    at = port.at;
    // Vertical port (diffuser neck, floor drain): riser from the port to the run height.
    if (Math.abs(port.dir.z) > 0.7 && Math.abs(z - port.z) > EPS_Z) riserFrom = { z: port.z, ref: portRef };
    else { z = port.z; startRef = portRef; }
  } else {
    const end = runEndAt(pt, table, elements, new Set());
    if (end) {
      z = end.z;
      da = inheritFrom({ system: end.curve.attrs.system_type, shape: end.curve.attrs.shape, w: end.curve.attrs.size_x, h: end.curve.attrs.size_y }, table, da);
    } else {
      const hit = findPipeBodyHit(pt, elements, { tolerance: 0.05, pickPadding: 0.05 });
      if (hit && hit.pipe.tableName === table) {
        at = hit.point;
        z = zAt(hit.pipe, hit.point);
        da = inheritFrom({ system: hit.pipe.attrs.system_type }, table, da);
      }
    }
  }
  da.start_z = String(round(z));
  const b = new Builder({ ...state, drawingAttrs: da });
  if (riserFrom) b.segment(at, riserFrom.z, at, z, { from: riserFrom.ref });
  chain.z = z;
  chain.typed = '';
  api.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: da });
  if (b.out.length > 0) api.dispatch({ type: 'CREATE_ELEMENTS', elements: b.out, description: 'Route', selectPrimary: false });
  api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [at], cursor: at, startPortRef: startRef } });
  notify();
}

/** Next click of a run: segment(s) to `pt`; ends the run when it connects to something. */
export function continueRoute(api: RouteApi, pt: Point, portRef: string | undefined): void {
  const state = api.getState();
  const elements = state.document?.elements;
  const table = state.drawingTarget?.tableName;
  const from = state.drawingState?.points[0];
  if (!elements || !table || !from) return;
  const da = state.drawingAttrs;
  const b = new Builder(state);
  const wanted = num(da.start_z, 3);
  let z = Number.isFinite(chain.z) ? chain.z : wanted;
  let startRef = state.drawingState?.startPortRef;
  const firstRefs = () => { const r = startRef ? { from: startRef } : {}; startRef = undefined; return r; };

  // Offset changed since the last click: rise / drop at the current point.
  if (Math.abs(wanted - z) > EPS_Z) {
    b.segment(from, z, from, wanted, firstRefs());
    z = wanted;
  }
  const slope = table === 'pipe' ? num(da[SLOPE_KEY]) / 100 : 0;
  const fall = (a: Point, c: Point) => slope * Math.hypot(c.x - a.x, c.y - a.y);
  let ended = true;
  let endPoint = pt;

  const port = portRef ? portInfo(portRef, elements) : null;
  if (port && portRef) {
    const q = port.at;
    const zq = z - fall(from, q);
    if (Math.abs(zq - port.z) <= EPS_Z) {
      b.segment(from, z, q, port.z, { ...firstRefs(), to: portRef });
    } else if (Math.abs(port.dir.z) > 0.7) {
      // Above / below a vertical port: run to it, then straight down / up into it.
      b.segment(from, z, q, zq, firstRefs());
      b.segment(q, zq, q, port.z, { to: portRef });
    } else {
      // Horizontal port at another height: come in level with it, one stub out.
      const stub = Math.max(0.3, num(da.size_x, 0.2) * 1.5);
      const len = Math.hypot(port.dir.x, port.dir.y) || 1;
      const q2 = { x: q.x + (port.dir.x / len) * stub, y: q.y + (port.dir.y / len) * stub };
      const z2 = z - fall(from, q2);
      b.segment(from, z, q2, z2, firstRefs());
      b.segment(q2, z2, q2, port.z);
      b.segment(q2, port.z, q, port.z, { to: portRef });
    }
  } else {
    const end = runEndAt(pt, table, elements, new Set());
    const hit = end ? null : findPipeBodyHit(pt, elements, { tolerance: 0.05, pickPadding: 0.05, systemType: da.system_type || undefined });
    if (end) {
      const zEnd = z - fall(from, pt);
      b.segment(from, z, pt, zEnd, firstRefs());
      if (Math.abs(end.z - zEnd) > EPS_Z) b.segment(pt, zEnd, pt, end.z);
    } else if (hit && hit.pipe.tableName === table) {
      // Onto another run's body: tee into it (a vertical first if it is at another height).
      endPoint = hit.point;
      const zMain = zAt(hit.pipe, hit.point);
      const zb = z - fall(from, endPoint);
      b.segment(from, z, endPoint, zb, firstRefs());
      if (Math.abs(zMain - zb) > EPS_Z) b.segment(endPoint, zb, endPoint, zMain);
    } else {
      const zEnd = z - fall(from, pt);
      b.segment(from, z, pt, zEnd, firstRefs());
      z = zEnd;
      ended = false;
    }
  }

  if (b.out.length > 0) api.dispatch({ type: 'CREATE_ELEMENTS', elements: b.out, description: 'Route', selectPrimary: false });
  chain.typed = '';
  if (ended) {
    chain.z = NaN;
    api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  } else {
    chain.z = z;
    if (Math.abs(num(da.start_z) - z) > EPS_Z) api.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...da, start_z: String(round(z)) } });
    api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [endPoint], cursor: endPoint } });
  }
  notify();
}

/** Typed length: next segment of that length towards the cursor. */
export function commitTypedLength(api: RouteApi, length: number): boolean {
  const state = api.getState();
  const from = state.drawingState?.points[0];
  const cursor = state.drawingState?.cursor;
  if (!from || !(length > 0)) return false;
  let dx = 1, dy = 0;
  if (cursor) {
    const l = Math.hypot(cursor.x - from.x, cursor.y - from.y);
    if (l > 1e-6) { dx = (cursor.x - from.x) / l; dy = (cursor.y - from.y) / l; }
  }
  continueRoute(api, { x: from.x + dx * length, y: from.y + dy * length }, undefined);
  return true;
}

/** Pointer handling (drawLineTool delegates MEP tables here). */
export function routePointerDown(ctx: ToolContext, e: React.PointerEvent): void {
  if (e.button !== 0) return;
  const snap = snapAt(ctx, e);
  if (!snap) return;
  ctx.setSnap(snap);
  const api: RouteApi = { dispatch: ctx.dispatch as (a: EditorAction) => void, getState: ctx.getState };
  const points = ctx.getState().drawingState?.points ?? [];
  if (points.length === 0) startRoute(api, snap.point, snap.connectorHit?.portRef);
  else continueRoute(api, snap.point, snap.connectorHit?.portRef);
}

export function routePointerMove(ctx: ToolContext, e: React.PointerEvent): void {
  const snap = snapAt(ctx, e);
  if (!snap) return;
  const state = ctx.getState();
  if (state.drawingState && state.drawingState.points.length > 0) {
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...state.drawingState, cursor: snap.point } });
  }
  ctx.setSnap(snap);
}
