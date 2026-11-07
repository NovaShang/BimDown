/**
 * Continuous MEP routing (duct / pipe / conduit / cable tray).
 *
 * Click, click, click: every click ends a segment and starts the next one
 * from the same point, so a run is drawn in one go; elbows, tees and
 * reducers come from the endpoint bonding in the reducer (passive nodes) and
 * draw as real fittings. Esc / right-click ends the run; the tool stays
 * armed (a second Esc leaves it), also after a run ended by itself on a
 * port or another run.
 *
 * Ortho: segments are orthogonal by default (along the previous segment or
 * its perpendicular, the world axes for the first one, the port direction
 * out of a horizontal port); holding Shift draws at any angle. The toolbar
 * toggle (or F8) flips the default, then Shift locks ortho, as in Revit.
 * Snaps can slide a point along the ortho axis but never pull it off it; a
 * port off the axis is reached with an L.
 *
 * Heights: the toolbar `Offset` (start_z) is the run's centre-line height.
 * Changing it mid-run inserts a vertical segment (rise / drop) at the current
 * point; clicking the current point again after changing it draws only that
 * vertical. A pipe slope (%) makes each segment fall along the drawing
 * direction and the Offset follows the run. A run that starts or ends on a
 * port, a run end or another run's body at a different height gets the
 * vertical segment it needs to really meet it (diffusers below the duct, a
 * pump nozzle, a main at another height); a click on the same plan point
 * as the run's current point connects straight up / down into a run or a
 * vertical port there (tap + drop). Gravity pipes (sanitary, storm) slope
 * into the main they end on, taking its slope when the toolbar has none,
 * and join it with a 45° wye. Starting on a port or a run takes its system,
 * size and height; ending on a port of another size adds a transition.
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
/** 'false' = free angles by default (Shift then locks ortho). */
export const ORTHO_KEY = '__ortho';
const VERTICAL_MODE_KEY = '__vertical_mode';
const EPS_Z = 1e-3;
const JOIN_TOL = 0.01;
/** Gravity drainage slope when neither the toolbar nor the main gives one (%). */
export const DEFAULT_DRAIN_SLOPE = 2;

/** Drainage systems: runs fall towards the main / stack and join with wyes. */
export function isGravitySystem(code: string | undefined): boolean {
  return /^(SAN|SAN\d*|SS|SW|SD|ST|STORM|RWL|RW|W|WASTE|D|DR|DRAIN|SOIL|CD|COND)$/i.test((code ?? '').trim());
}

type RouteState = Pick<ToolStateSnapshot, 'document' | 'project' | 'drawingAttrs' | 'drawingTarget' | 'drawingState' | 'grids' | 'disabledSnapTypes'>;

export interface RouteApi {
  dispatch: (a: EditorAction) => void;
  getState: () => RouteState;
}

export interface RouteOpts {
  /** Constrain to the ortho axes (L-route to an off-axis port). */
  ortho?: boolean;
}

interface Chain {
  /** Height (level-relative) of the run at the current point. */
  z: number;
  /** Typed segment length, as typed. */
  typed: string;
  /** Plan direction of the last horizontal segment (ortho axes). */
  dir: Point | null;
  /** First segment out of a horizontal port: along this direction only. */
  portDir: Point | null;
  /** Started on a vertical port: its rise / drop is drawn with the next click. */
  pending: { ref: string; z: number } | null;
  /** Segments of this run (never a tee / join target for its own clicks). */
  ids: Set<string>;
  /** Where the cursor really was at the last click (before snapping). */
  lastRaw: Point | null;
}

const chain: Chain = { z: NaN, typed: '', dir: null, portDir: null, pending: null, ids: new Set(), lastRaw: null };
/** The last run ended by itself (on a port / run): the next Esc only acknowledges it. */
let endedByItself = false;
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

/**
 * Esc after a run ended by itself: true (and the flag is cleared) when the
 * keypress should only end the run that already ended, keeping the tool.
 */
export function consumeRouteEnded(): boolean {
  const v = endedByItself;
  endedByItself = false;
  return v;
}

export function isRouting(state: RouteState): boolean {
  return isMepLineTable(state.drawingTarget?.tableName) && (state.drawingState?.points.length ?? 0) > 0
    && state.drawingAttrs[VERTICAL_MODE_KEY] !== 'true';
}

/** The MEP routing tool is armed (no run in progress needed). */
export function isRouteTool(state: Pick<RouteState, 'drawingTarget' | 'drawingAttrs'>): boolean {
  return isMepLineTable(state.drawingTarget?.tableName) && state.drawingAttrs[VERTICAL_MODE_KEY] !== 'true';
}

/** Ortho for this pointer event: the default (toolbar toggle) flipped by Shift. */
export function orthoActive(da: Record<string, string>, shift: boolean): boolean {
  const on = da[ORTHO_KEY] !== 'false';
  return shift ? !on : on;
}

// ── Remembered settings per table (re-picking the tool keeps them) ──

const REMEMBER = ['system_type', 'shape', 'size_x', 'size_y', SLOPE_KEY, ORTHO_KEY, 'start_z', 'flexible', 'material', 'insulation_thickness'];
const memory = new Map<string, Record<string, string>>();

/** Drawing attrs last used for `table` (placement defaults of the MEP line tools). */
export function rememberedRouteAttrs(table: string): Record<string, string> {
  return { ...(memory.get(table) ?? {}) };
}

function remember(table: string, da: Record<string, string>): void {
  const m: Record<string, string> = {};
  for (const k of REMEMBER) if (da[k] !== undefined && da[k] !== '') m[k] = da[k];
  memory.set(table, m);
}

/** Tests: forget remembered settings and run state. */
export function resetRouteMemory(): void {
  memory.clear();
  endedByItself = false;
  resetChain(NaN);
}

function resetChain(z: number): void {
  chain.z = z;
  chain.typed = '';
  chain.dir = null;
  chain.portDir = null;
  chain.pending = null;
  chain.ids = new Set();
  chain.lastRaw = null;
}

function num(v: string | undefined, fallback = 0): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
}

export interface PortInfo {
  ref: string;
  hostId: string;
  at: Point;
  z: number;
  dir: { x: number; y: number; z: number };
  system: string;
  shape: string;
  w: string;
  h: string;
  domain: string;
}

/** Port info for a port ref: world position, height, outward direction (3D), system and section. */
export function portInfo(ref: string, elements: ReadonlyMap<string, CanonicalElement>): PortInfo | null {
  const p = parsePortRef(ref);
  if (!p?.portName) return null;
  const host = findHostElement(p.hostId, elements) as PointElement | null;
  const conn = findConnectorByPort(p.hostId, p.portName, elements);
  if (!host || !conn) return null;
  const rot = (num(host.attrs.rotation) * Math.PI) / 180;
  const ox = num(conn.attrs.offset_x), oy = num(conn.attrs.offset_y), oz = num(conn.attrs.offset_z);
  const dx = num(conn.attrs.dir_x, 1), dy = num(conn.attrs.dir_y), dz = num(conn.attrs.dir_z);
  return {
    ref, hostId: host.id,
    at: { x: host.position.x + ox * Math.cos(rot) - oy * Math.sin(rot), y: host.position.y + ox * Math.sin(rot) + oy * Math.cos(rot) },
    z: num(host.attrs.base_offset) + oz,
    dir: { x: dx * Math.cos(rot) - dy * Math.sin(rot), y: dx * Math.sin(rot) + dy * Math.cos(rot), z: dz },
    system: (conn.attrs.system_type || '').trim(),
    shape: (conn.attrs.shape || '').trim(),
    w: (conn.attrs.size_w || '').trim(),
    h: (conn.attrs.size_h || '').trim(),
    domain: (conn.attrs.domain || '').trim(),
  };
}

const DOMAIN_TABLES: Record<string, string[]> = {
  hvac: ['duct'], piping: ['pipe'], electrical: ['conduit', 'cable_tray'], cable_tray_conduit: ['conduit', 'cable_tray'],
};

/** A vertical port (diffuser neck, fixture drain) of the run's domain right above / below `p`. */
function verticalPortNear(p: Point, radius: number, table: string, elements: ReadonlyMap<string, CanonicalElement>): PortInfo | null {
  let best: { info: PortInfo; d: number } | null = null;
  for (const cp of gatherConnectorSnapPoints(elements)) {
    const d = Math.hypot(cp.pos.x - p.x, cp.pos.y - p.y);
    if (d > radius || (best && d >= best.d)) continue;
    const info = portInfo(cp.portRef, elements);
    if (!info || Math.abs(info.dir.z) < 0.7) continue;
    if (info.domain && DOMAIN_TABLES[info.domain] && !DOMAIN_TABLES[info.domain].includes(table)) continue;
    best = { info, d };
  }
  return best?.info ?? null;
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

// ── Ortho ──

const perp = (d: Point): Point => ({ x: -d.y, y: d.x });
const unit = (d: Point): Point | null => {
  const l = Math.hypot(d.x, d.y);
  return l > 1e-9 ? { x: d.x / l, y: d.y / l } : null;
};

/** Ortho axes from the current point of the run. */
export function orthoAxes(): Point[] {
  if (chain.portDir) return [chain.portDir];
  const d = chain.dir ?? { x: 1, y: 0 };
  // After a free-angle segment the world axes are offered too.
  const aligned = Math.abs(d.x) < 1e-6 || Math.abs(d.y) < 1e-6;
  return aligned ? [d, perp(d)] : [d, perp(d), { x: 1, y: 0 }, { x: 0, y: 1 }];
}

/** `raw` projected on the axis through `from` it is closest to. */
export function constrainOrtho(from: Point, raw: Point, axes: Point[] = orthoAxes()): { point: Point; axis: Point } {
  let best = { point: from, axis: axes[0], score: -1 };
  for (const a of axes) {
    const t = (raw.x - from.x) * a.x + (raw.y - from.y) * a.y;
    // A port direction is one-way: never route back into the device.
    const tt = axes.length === 1 ? Math.max(0, t) : t;
    const score = axes.length === 1 ? 1 : Math.abs(t);
    if (score > best.score) best = { point: { x: from.x + a.x * tt, y: from.y + a.y * tt }, axis: a, score };
  }
  return { point: best.point, axis: best.axis };
}

function onAxis(from: Point, p: Point, axes: Point[]): boolean {
  return axes.some(a => Math.abs((p.x - from.x) * a.y - (p.y - from.y) * a.x) < 1e-6);
}

// ── Segment builder ──

class Builder {
  readonly out: MepCurve[] = [];
  /** Device connectors / hosts patched to the run's system. */
  readonly patches: CanonicalElement[] = [];
  private ids: Set<string>;
  private state: RouteState;
  constructor(state: RouteState) {
    this.state = state;
    this.ids = reservedIds(state.document?.elements);
  }
  get table(): string { return this.state.drawingTarget!.tableName; }
  segment(a: Point, za: number, b: Point, zb: number, refs: { from?: string; to?: string } = {}, over: Record<string, string> = {}): MepCurve | null {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-4 && Math.abs(zb - za) < EPS_Z) return null;
    const target = this.state.drawingTarget!;
    const id = generateId(target.tableName, this.ids);
    this.ids.add(id);
    const da = this.state.drawingAttrs;
    const attrs: Record<string, string> = {
      ...defaultAttrs(target.tableName, resolveNextLevelId(this.state)),
      ...variantDefaults(target.tableName, target.variantId),
      ...da,
      ...over,
      id,
      start_z: String(round(za)),
      end_z: String(round(zb)),
    };
    for (const k of Object.keys(attrs)) if (k.startsWith('__')) delete attrs[k];
    // Round sections carry one size (no stale size_y).
    if (target.tableName === 'pipe' || target.tableName === 'conduit' || attrs.shape === 'round') attrs.size_y = attrs.size_x;
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

  /**
   * The segment `seg` meets `port` at its `side` end: when the port has
   * another size, its last stretch takes the port's size, so the node in
   * between draws a transition / reducer.
   */
  fitPort(seg: MepCurve | null, side: 'start' | 'end', port: PortInfo): void {
    if (!seg || !port.w || sameSize(seg.attrs, port, seg.tableName)) return;
    const near = side === 'start' ? seg.start : seg.end, far = side === 'start' ? seg.end : seg.start;
    const zNear = side === 'start' ? seg.startZ : seg.endZ, zFar = side === 'start' ? seg.endZ : seg.startZ;
    const L = Math.hypot(far.x - near.x, far.y - near.y, zFar - zNear);
    if (L < 0.12) return;
    const sec = portSection(port, seg.tableName);
    const step = Math.max(Math.abs(num(seg.attrs.size_x) - num(sec.size_x)), Math.abs(num(seg.attrs.size_y) - num(sec.size_y)), 0.05);
    const want = Math.max(0.15, (step / 2) / Math.tan((20 * Math.PI) / 180) + 0.05);
    const t = Math.min(0.5, want / L);
    const m = { x: near.x + (far.x - near.x) * t, y: near.y + (far.y - near.y) * t };
    const zm = round(zNear + (zFar - zNear) * t);
    // The run part keeps `seg`'s id; the stub at the port is a new segment.
    const refKey = side === 'start' ? 'from' : 'to';
    const ref = seg.attrs[refKey];
    if (side === 'start') { seg.start = m; seg.startZ = zm; seg.attrs.start_z = String(zm); }
    else { seg.end = m; seg.endZ = zm; seg.attrs.end_z = String(zm); }
    delete seg.attrs[refKey];
    const stub = side === 'start'
      ? this.segment(near, zNear, m, zm, { from: ref }, sec)
      : this.segment(m, zm, near, zNear, { to: ref }, sec);
    if (stub) stub.strokeWidth = resolveLineStrokeWidth(stub.tableName, stub.attrs) ?? stub.strokeWidth;
  }

  /** A pass-through device (pump, inline fan, VAV) joins the run's system. */
  adoptSystem(port: PortInfo): void {
    const system = (this.state.drawingAttrs.system_type ?? '').trim();
    const elements = this.state.document?.elements;
    if (!system || !elements || port.system === system) return;
    const ports = [...elements.values()].filter(e => e.tableName === 'connector' && (e.hostId || e.attrs.host_id) === parsePortRef(port.ref)?.hostId);
    const fluid = ports.filter(c => (c.attrs.domain ?? '') !== 'electrical');
    if (fluid.length !== 2) return;
    const dirs = fluid.map(c => (c.attrs.flow_dir ?? '').trim()).sort().join(',');
    if (dirs !== 'in,out' || fluid.some(c => (c.attrs.system_type ?? '') !== port.system)) return;
    // Not when its other side already runs on another system.
    const hostId = parsePortRef(port.ref)?.hostId ?? '';
    for (const el of elements.values()) {
      if (!isMepLineTable(el.tableName)) continue;
      for (const r of [el.attrs.from, el.attrs.to]) {
        const p = parsePortRef(r);
        if (p?.hostId === hostId && (el.attrs.system_type ?? '') && el.attrs.system_type !== system) return;
      }
    }
    for (const c of fluid) this.patches.push({ ...c, attrs: { ...c.attrs, system_type: system } });
    const host = elements.get(port.hostId);
    if (host) this.patches.push({ ...host, attrs: { ...host.attrs, system_type: system } });
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Section attrs (shape / size_x / size_y) of a port, as a run of `table` would carry them. */
function portSection(port: PortInfo, table: string): Record<string, string> {
  const round = table === 'pipe' || table === 'conduit' || port.shape === 'round';
  const out: Record<string, string> = { size_x: port.w, size_y: round ? port.w : (port.h || port.w) };
  if (table === 'duct' || table === 'cable_tray') out.shape = round ? 'round' : 'rect';
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-3, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

/** A run section equals a port section (rect sides in either order). */
export function sameSize(attrs: Record<string, string>, port: { shape: string; w: string; h: string }, table: string): boolean {
  const w = num(attrs.size_x), pw = num(port.w);
  if (!(w > 0) || !(pw > 0)) return true;
  const runRound = table === 'pipe' || table === 'conduit' || (attrs.shape || (table === 'duct' ? 'rect' : 'round')) === 'round';
  const portRound = table === 'pipe' || table === 'conduit' || port.shape === 'round' || !num(port.h);
  if (runRound !== portRound) return false;
  if (runRound) return near(w, pw);
  const h = num(attrs.size_y, w), ph = num(port.h, pw);
  return (near(w, pw) && near(h, ph)) || (near(w, ph) && near(h, pw));
}

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
  resetChain(z);
  endedByItself = false;

  const port = portRef ? portInfo(portRef, elements) : null;
  if (port && portRef) {
    // A pass-through device keeps the system the user is drawing.
    const keepSystem = da.system_type && port.system !== da.system_type && isPassThrough(port, elements);
    da = inheritFrom(keepSystem ? { ...port, system: da.system_type } : port, table, da);
    at = port.at;
    // Vertical port (diffuser neck, floor drain): the rise / drop to the run
    // height comes with the next click (or a tap straight into a run there).
    if (Math.abs(port.dir.z) > 0.7 && Math.abs(z - port.z) > EPS_Z) chain.pending = { ref: portRef, z: port.z };
    else {
      z = port.z; startRef = portRef;
      if (Math.abs(port.dir.z) <= 0.7) chain.portDir = unit(port.dir);
    }
  } else {
    const end = runEndAt(pt, table, elements, new Set());
    if (end) {
      z = end.z;
      da = inheritFrom({ system: end.curve.attrs.system_type, shape: end.curve.attrs.shape, w: end.curve.attrs.size_x, h: end.curve.attrs.size_y }, table, da);
      const c = end.curve;
      const d = unit({ x: c.end.x - c.start.x, y: c.end.y - c.start.y });
      if (d) chain.dir = d;
    } else {
      const hit = findPipeBodyHit(pt, elements, { tolerance: 0.05, pickPadding: 0.05 });
      if (hit && hit.pipe.tableName === table) {
        at = hit.point;
        z = zAt(hit.pipe, hit.point);
        da = inheritFrom({ system: hit.pipe.attrs.system_type }, table, da);
        // A branch leaves its main square: ortho axes follow the main.
        const d = unit({ x: hit.pipe.end.x - hit.pipe.start.x, y: hit.pipe.end.y - hit.pipe.start.y });
        if (d) chain.dir = d;
      }
    }
  }
  da.start_z = String(round(z));
  chain.z = z;
  remember(table, da);
  api.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: da });
  api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [at], cursor: at, startPortRef: startRef } });
  notify();
}

/** Two fluid ports, one in and one out, on one system (pump, inline fan, VAV, coil air side). */
function isPassThrough(port: PortInfo, elements: ReadonlyMap<string, CanonicalElement>): boolean {
  const hostId = parsePortRef(port.ref)?.hostId;
  const fluid = [...elements.values()].filter(e => e.tableName === 'connector' && (e.hostId || e.attrs.host_id) === hostId
    && (e.attrs.domain ?? '') === port.domain);
  return fluid.length === 2 && fluid.map(c => (c.attrs.flow_dir ?? '').trim()).sort().join(',') === 'in,out'
    && fluid.every(c => (c.attrs.system_type ?? '') === port.system);
}

/** Next click of a run: segment(s) to `pt`; ends the run when it connects to something. */
export function continueRoute(api: RouteApi, pt: Point, portRef: string | undefined, opts: RouteOpts = {}): void {
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
  const startPort = startRef ? portInfo(startRef, elements) : null;
  let fitStart = !!startPort;
  const firstRefs = () => { const r = startRef ? { from: startRef } : {}; startRef = undefined; return r; };
  /** Segment helper: wires the start port on the run's first segment (with a transition when needed). */
  const seg = (a: Point, za: number, c: Point, zc: number, refs: { from?: string; to?: string } = {}) => {
    const s = b.segment(a, za, c, zc, { ...firstRefs(), ...refs });
    if (s && fitStart && startPort && s.attrs.from === startPort.ref) { b.fitPort(s, 'start', startPort); fitStart = false; }
    return s;
  };
  if (startPort) b.adoptSystem(startPort);
  const pending = chain.pending;
  chain.pending = null;
  const exclude = chain.ids;
  const planLen = Math.hypot(pt.x - from.x, pt.y - from.y);
  const port = portRef ? portInfo(portRef, elements) : null;
  let ended = true;
  let endPoint = pt;
  const slopeSet = table === 'pipe' ? num(da[SLOPE_KEY]) / 100 : 0;
  let slope = slopeSet;

  if (planLen < JOIN_TOL && !(port && Math.hypot(port.at.x - from.x, port.at.y - from.y) >= JOIN_TOL)) {
    // ── Same plan point: verticals only (never a horizontal back-and-forth) ──
    const zFrom = pending ? pending.z : z;
    const pendingRefs = pending ? { from: pending.ref } : {};
    const sameDevice = port && pending && parsePortRef(port.ref)?.hostId === parsePortRef(pending.ref)?.hostId;
    const hit = findPipeBodyHit(from, elements, { tolerance: 0.05, pickPadding: 0.1, excludeIds: exclude });
    const end = runEndAt(from, table, elements, exclude);
    if (port && !sameDevice && Math.abs(port.z - zFrom) > EPS_Z) {
      // Straight down / up into the port under / over the run.
      const s = seg(from, zFrom, from, port.z, { ...pendingRefs, to: port.ref });
      b.fitPort(s, 'end', port);
      b.adoptSystem(port);
    } else if (hit && hit.pipe.tableName === table && Math.abs(zAt(hit.pipe, hit.point) - zFrom) > EPS_Z && Math.abs(wanted - z) <= EPS_Z) {
      // Tap straight into the run above / below (bonding adds the tee).
      const s = tapInto(seg, from, zFrom, hit.pipe as MepCurve, hit.point, pendingRefs);
      if (pending) { const pi = portInfo(pending.ref, elements); if (pi) b.fitPort(s, 'start', pi); }
    } else if (end && Math.abs(end.z - zFrom) > EPS_Z && Math.abs(wanted - z) <= EPS_Z) {
      seg(from, zFrom, from, end.z, pendingRefs);
    } else if (!pending && Math.abs(wanted - z) <= EPS_Z && isOnRunBody(from, elements, table, exclude)) {
      // Started on a run: drop / rise into a vertical port right under / over it.
      const vp = verticalPortNear(from, 0.35, table, elements);
      if (vp && Math.abs(vp.z - z) > EPS_Z) {
        const main = findPipeBodyHit(from, elements, { tolerance: 0.02, pickPadding: 0.02, excludeIds: exclude, endZoneRatio: 0 })!.pipe as MepCurve;
        const halfW = (parseFloat(main.attrs.size_x || '0.2') || 0.2) / 2;
        // Off the main by more than its half width: a short jog at the main's height first.
        if (Math.hypot(vp.at.x - from.x, vp.at.y - from.y) > halfW) seg(from, z, vp.at, z);
        const s = seg(vp.at, z, vp.at, vp.z, { to: vp.ref });
        b.fitPort(s, 'end', vp);
      } else ended = false;
    } else if (Math.abs(wanted - zFrom) > EPS_Z) {
      // Offset changed, same point clicked: one rise / drop, the run goes on.
      seg(from, zFrom, from, wanted, pendingRefs);
      z = wanted;
      const meet = findPipeBodyHit(from, elements, { tolerance: 0.05, pickPadding: 0.05, excludeIds: exclude });
      const meetEnd = runEndAt(from, table, elements, exclude);
      ended = (!!meet && meet.pipe.tableName === table && Math.abs(zAt(meet.pipe, meet.point) - z) <= EPS_Z)
        || (!!meetEnd && Math.abs(meetEnd.z - z) <= EPS_Z);
    } else {
      // Double click on the current point: nothing to draw.
      chain.pending = pending;
      ended = false;
    }
    return finish(api, b, da, z, ended, from, table);
  }

  // Offset changed since the last click: rise / drop at the current point.
  if (pending) {
    seg(from, pending.z, from, wanted, { from: pending.ref });
    const pi = portInfo(pending.ref, elements);
    if (pi && b.out[0]) b.fitPort(b.out[b.out.length - 1], 'start', pi);
    z = wanted;
  } else if (Math.abs(wanted - z) > EPS_Z && startPort && Math.abs(startPort.dir.z) <= 0.7 && !port
    && !findPipeBodyHit(pt, elements, { tolerance: 0.05, pickPadding: 0.05, excludeIds: exclude }) && !runEndAt(pt, table, elements, exclude)) {
    // Out of a side port at another height: leave the port level, rise / drop where clicked.
    seg(from, z, pt, z);
    seg(pt, z, pt, wanted);
    const d = unit({ x: pt.x - from.x, y: pt.y - from.y });
    if (d) { chain.dir = d; chain.portDir = null; }
    return finish(api, b, da, wanted, false, pt, table);
  } else if (Math.abs(wanted - z) > EPS_Z) {
    seg(from, z, from, wanted);
    z = wanted;
  }
  const fall = (a: Point, c: Point, s = slope) => s * Math.hypot(c.x - a.x, c.y - a.y);
  let cur = from;

  // Ortho: an off-axis port is reached with an L (last leg along the port).
  if (opts.ortho && port && !onAxis(from, port.at, orthoAxes())) {
    const q = port.at;
    let corner: Point;
    const pd = Math.abs(port.dir.z) > 0.7 ? null : unit(port.dir);
    if (pd) {
      const t = (from.x - q.x) * pd.x + (from.y - q.y) * pd.y;
      corner = { x: q.x + pd.x * t, y: q.y + pd.y * t };
      if (!onAxis(from, corner, orthoAxes())) corner = constrainOrtho(from, q).point;
    } else corner = constrainOrtho(from, q).point;
    if (Math.hypot(corner.x - from.x, corner.y - from.y) > JOIN_TOL) {
      const zc = z - fall(from, corner);
      seg(from, z, corner, zc);
      z = zc; cur = corner;
    }
  }

  if (port && portRef) {
    const q = port.at;
    const zq = z - fall(cur, q);
    b.adoptSystem(port);
    if (Math.abs(zq - port.z) <= EPS_Z) {
      b.fitPort(seg(cur, z, q, port.z, { to: portRef }), 'end', port);
    } else if (Math.abs(port.dir.z) > 0.7) {
      // Above / below a vertical port: run to it, then straight down / up into it.
      seg(cur, z, q, zq);
      b.fitPort(seg(q, zq, q, port.z, { to: portRef }), 'end', port);
    } else {
      // Horizontal port at another height: come in level with it, one stub out.
      const stub = Math.max(0.3, num(da.size_x, 0.2) * 1.5);
      const len = Math.hypot(port.dir.x, port.dir.y) || 1;
      const q2 = { x: q.x + (port.dir.x / len) * stub, y: q.y + (port.dir.y / len) * stub };
      const z2 = z - fall(cur, q2);
      seg(cur, z, q2, z2);
      seg(q2, z2, q2, port.z);
      b.fitPort(seg(q2, port.z, q, port.z, { to: portRef }), 'end', port);
    }
  } else {
    const end = runEndAt(pt, table, elements, exclude);
    const hit = end ? null : findPipeBodyHit(pt, elements, { tolerance: 0.05, pickPadding: 0.05, systemType: da.system_type || undefined, excludeIds: exclude });
    if (end) {
      const zEnd = z - fall(cur, pt);
      seg(cur, z, pt, zEnd);
      if (Math.abs(end.z - zEnd) > EPS_Z) seg(pt, zEnd, pt, end.z);
    } else if (hit && hit.pipe.tableName === table) {
      // Onto another run's body: tee into it (a vertical first if it is at another height).
      const main = hit.pipe as MepCurve;
      endPoint = opts.ortho ? (axisMeetsRun(cur, pt, main) ?? hit.point) : hit.point;
      const zMain = zAt(main, endPoint);
      const gravity = table === 'pipe' && isGravitySystem(da.system_type) && isGravitySystem(main.attrs.system_type);
      if (gravity) {
        // Drainage: fall into the main (its slope when none is set), drop first, join with a wye.
        const mainSlope = Math.abs(runSlopeOf(main));
        if (!(slope > 0)) slope = mainSlope > 0 ? mainSlope : DEFAULT_DRAIN_SLOPE / 100;
        const wye = wyeApproach(cur, endPoint, main);
        const target = wye ? wye.join : endPoint;
        const legs = wye ? [wye.corner, wye.join] : [target];
        let planTotal = 0;
        let prev = cur;
        for (const p of legs) { planTotal += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
        const zJoin = zAt(main, target);
        const zStart = zJoin + slope * planTotal;
        if (zStart < z - EPS_Z) { seg(cur, z, cur, zStart); z = zStart; }
        prev = cur;
        for (const p of legs) {
          const zn = z - slope * Math.hypot(p.x - prev.x, p.y - prev.y);
          seg(prev, z, p, zn);
          z = zn; prev = p;
        }
        if (Math.abs(zJoin - z) > EPS_Z) seg(prev, z, prev, zJoin);
        endPoint = target;
      } else {
        const zb = z - fall(cur, endPoint);
        seg(cur, z, endPoint, zb);
        if (Math.abs(zMain - zb) > EPS_Z) seg(endPoint, zb, endPoint, zMain);
      }
    } else {
      const zEnd = z - fall(cur, pt);
      seg(cur, z, pt, zEnd);
      z = zEnd;
      ended = false;
    }
  }
  const lastDir = unit({ x: endPoint.x - cur.x, y: endPoint.y - cur.y });
  if (lastDir) { chain.dir = lastDir; chain.portDir = null; }
  return finish(api, b, da, z, ended, endPoint, table);
}

function finish(api: RouteApi, b: Builder, da: Record<string, string>, z: number, ended: boolean, endPoint: Point, table: string): void {
  const state = api.getState();
  if (b.out.length > 0) {
    if (b.patches.length > 0) {
      const patches = new Map<string, CanonicalElement | null>(b.patches.map(e => [e.id, e]));
      api.dispatch({ type: 'APPLY_PATCH', patches, description: 'Route: device system' });
    }
    api.dispatch({ type: 'CREATE_ELEMENTS', elements: b.out, description: 'Route', selectPrimary: false });
    for (const s of b.out) chain.ids.add(s.id);
  }
  chain.typed = '';
  remember(table, da);
  if (ended) {
    resetChain(NaN);
    endedByItself = b.out.length > 0;
    api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  } else {
    chain.z = z;
    if (Math.abs(num(da.start_z) - z) > EPS_Z) {
      const next = { ...state.drawingAttrs, start_z: String(round(z)) };
      api.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: next });
      remember(table, next);
    }
    api.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [endPoint], cursor: endPoint } });
  }
  notify();
}

/**
 * Vertical from the run's point straight into `main` above / below. Within
 * the main's half width the riser leans onto its centre line (the tee);
 * further off, it rises in place and jogs over at the main's height.
 */
function tapInto(seg: (a: Point, za: number, c: Point, zc: number, refs?: { from?: string; to?: string }) => MepCurve | null,
  at: Point, z: number, main: MepCurve, onMain: Point, refs: { from?: string }): MepCurve | null {
  const zMain = zAt(main, onMain);
  const halfW = (parseFloat(main.attrs.size_x || '0.2') || 0.2) / 2;
  if (Math.hypot(onMain.x - at.x, onMain.y - at.y) <= halfW) return seg(at, z, at, zMain, refs);
  const s = seg(at, z, at, zMain, refs);
  seg(at, zMain, onMain, zMain);
  return s;
}

/** Where the line from `a` through `b` crosses `main` (plan), if it does inside it. */
function axisMeetsRun(a: Point, b: Point, main: MepCurve): Point | null {
  const d = { x: b.x - a.x, y: b.y - a.y }, m = { x: main.end.x - main.start.x, y: main.end.y - main.start.y };
  const den = d.x * m.y - d.y * m.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((main.start.x - a.x) * m.y - (main.start.y - a.y) * m.x) / den;
  const u = ((main.start.x - a.x) * d.y - (main.start.y - a.y) * d.x) / den;
  if (u <= 0.02 || u >= 0.98 || t <= 0) return null;
  return { x: a.x + d.x * t, y: a.y + d.y * t };
}

/** Plan point `p` lies on a run body of `table` (not one of this run's segments). */
function isOnRunBody(p: Point, elements: ReadonlyMap<string, CanonicalElement>, table: string, exclude: Set<string>): boolean {
  const hit = findPipeBodyHit(p, elements, { tolerance: 0.02, pickPadding: 0.02, excludeIds: exclude, endZoneRatio: 0 });
  return !!hit && hit.pipe.tableName === table;
}

function runSlopeOf(c: MepCurve): number {
  const l = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y);
  return l > 1e-6 ? (c.endZ - c.startZ) / l : 0;
}

/**
 * Drainage branch square onto a main: turn 45° towards the flow just before
 * the main, so the join is a wye. Null when the branch isn't square to the
 * main or too short for it.
 */
export function wyeApproach(from: Point, hitPoint: Point, main: MepCurve): { corner: Point; join: Point } | null {
  const m = unit({ x: main.end.x - main.start.x, y: main.end.y - main.start.y });
  const br = unit({ x: hitPoint.x - from.x, y: hitPoint.y - from.y });
  if (!m || !br) return null;
  if (Math.abs(m.x * br.x + m.y * br.y) > 0.05) return null;
  // Flow: downhill along a sloped main, else along its drawing direction.
  const flow = main.endZ > main.startZ + EPS_Z ? { x: -m.x, y: -m.y } : m;
  const D = Math.hypot(hitPoint.x - from.x, hitPoint.y - from.y);
  const e = Math.min(Math.max(0.2, 2 * (parseFloat(main.attrs.size_x || '0.1') || 0.1)), D * 0.5);
  const join = { x: hitPoint.x + flow.x * e, y: hitPoint.y + flow.y * e };
  // The join must stay on the main.
  const t = ((join.x - main.start.x) * m.x + (join.y - main.start.y) * m.y) / Math.hypot(main.end.x - main.start.x, main.end.y - main.start.y);
  if (t <= 0.02 || t >= 0.98) return null;
  return { corner: { x: hitPoint.x - br.x * e, y: hitPoint.y - br.y * e }, join };
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

/**
 * Snap for the router. With ortho on, a port under the cursor still wins
 * (the router reaches it with an L); any other snap only slides the point
 * along the ortho axis.
 */
function snapAt(ctx: ToolContext, e: React.PointerEvent): SnapResult | null {
  const svgPt = ctx.screenToSvg(e.clientX, e.clientY);
  if (!svgPt) return null;
  const state = ctx.getState();
  const anchor = state.drawingState?.points[0] ?? undefined;
  const connectors = gatherConnectorSnapPoints(state.document?.elements);
  const run = (p: Point) => snapPoint(p, ctx.screenToSvg, state.document?.elements, undefined, anchor, undefined, state.grids, undefined, connectors, getProjectUnits(state), state.disabledSnapTypes);
  // Clicking where the last click was (e.g. after changing the Offset) means
  // the run's current point, whatever the snaps would make of it now.
  if (anchor && chain.lastRaw) {
    const px = ctx.screenToSvg(e.clientX + SAME_POINT_PX, e.clientY);
    const tol = px ? Math.hypot(px.x - svgPt.x, px.y - svgPt.y) : 0;
    if (Math.hypot(svgPt.x - chain.lastRaw.x, svgPt.y - chain.lastRaw.y) <= tol) {
      return { point: { ...anchor }, snapX: null, snapY: null, guides: [] };
    }
  }
  const raw = run(svgPt);
  if (!anchor || raw.connectorHit || !orthoActive(state.drawingAttrs, !!e.shiftKey)) return raw;
  const { point, axis } = constrainOrtho(anchor, svgPt);
  const s = run(point);
  if (s.connectorHit) return s;
  const t = (s.point.x - anchor.x) * axis.x + (s.point.y - anchor.y) * axis.y;
  return { ...s, point: { x: anchor.x + axis.x * t, y: anchor.y + axis.y * t } };
}

/** Pointer handling (drawLineTool delegates MEP tables here). */
export function routePointerDown(ctx: ToolContext, e: React.PointerEvent): void {
  if (e.button !== 0) return;
  const snap = snapAt(ctx, e);
  if (!snap) return;
  ctx.setSnap(snap);
  const api: RouteApi = { dispatch: ctx.dispatch as (a: EditorAction) => void, getState: ctx.getState };
  const points = ctx.getState().drawingState?.points ?? [];
  const raw = ctx.screenToSvg(e.clientX, e.clientY);
  if (points.length === 0) startRoute(api, snap.point, snap.connectorHit?.portRef);
  else continueRoute(api, snap.point, snap.connectorHit?.portRef, { ortho: orthoActive(ctx.getState().drawingAttrs, !!e.shiftKey) });
  chain.lastRaw = (ctx.getState().drawingState?.points.length ?? 0) > 0 && raw ? raw : null;
}

/** A click within this many screen pixels of the last one is "the same point". */
const SAME_POINT_PX = 6;

export function routePointerMove(ctx: ToolContext, e: React.PointerEvent): void {
  const snap = snapAt(ctx, e);
  if (!snap) return;
  const state = ctx.getState();
  if (state.drawingState && state.drawingState.points.length > 0) {
    ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { ...state.drawingState, cursor: snap.point } });
  }
  ctx.setSnap(snap);
}

/** Esc / right-click while a run is in progress: end it (the tool stays). */
export function endRoute(): void {
  resetChain(NaN);
  endedByItself = false;
  notify();
}
