/**
 * Passive MEP fittings: what each passive mep_node is (elbow / tee / tap /
 * cross / reducer / transition / coupling / cap) and the real body it gets.
 *
 * Render-only and non-destructive, like `mepFittingRender`: curves keep their
 * stored end points (at the node centre for editor-drawn runs, at the fitting
 * face for Revit exports). For drawing, each curve end at a passive node is
 * first put on the node and then pulled back along the curve by the fitting's
 * arm ("trim"), so the duct stops at the fitting face and the node draws the
 * fitting body in the gap: a radiused elbow, a tee with collars, a reducer
 * cone. The same analysis feeds 2D (plan outlines) and 3D (meshes), and the
 * IFC exporter can reuse it (kind, legs, arm lengths, bend radius).
 */
import type { GeometryContext } from '../elements/archetypes.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, Point } from '../model/elements.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { MEP_LINE_TABLES } from '../model/mepTopology.ts';
import { add, cross, dot, len, mul, norm, sub, type V3, type Section } from './geom3d.ts';

type MepCurve = LineElement | SpatialLineElement;

export type FittingKind =
  | 'orphan' | 'cap' | 'open' | 'coupling' | 'reducer' | 'transition' | 'elbow'
  | 'tee' | 'tap' | 'cross' | 'wye' | 'manifold';

export interface FittingLeg {
  curveId: string;
  table: string;
  side: 'start' | 'end';
  /** Unit direction from the node centre into the curve (model frame). */
  dir: V3;
  sec: Section;
  insulation: number;
  /** Full curve length (3D). */
  length: number;
  /** How far the curve end is pulled back from the node centre. */
  trim: number;
  /** Section extent across the curve, in the plan (for drawing). */
  planWidth: number;
}

export interface FittingInfo {
  nodeId: string;
  /** Node centre, model frame, level-relative z. */
  center: V3;
  kind: FittingKind;
  legs: FittingLeg[];
  /** Elbow centre-line radius (0 = mitred). */
  radius: number;
  /** Tee / cross / tap: indices of the two collinear main legs. */
  main: [number, number] | null;
  system: string;
  table: string;
}

export interface FittingAnalysis {
  byNode: Map<string, FittingInfo>;
  /** Effective (snapped + trimmed) end points per curve, model frame. */
  ends: Map<string, { start?: V3; end?: V3 }>;
  /** Vertical curves: width-axis hint (model dir of the run they join). */
  riserRight: Map<string, V3>;
}

/** Max distance (m) a stored end may sit from the node it references. */
const SNAP_TOL = 2.0;
/** Ends this close in height are put on the node's height too. */
const Z_SNAP_TOL = 1.0;
/** Two legs closer to anti-parallel than this are one straight run. */
const STRAIGHT_DOT = -0.985;

export function curveZ(ln: MepCurve): { startZ: number; endZ: number } {
  if (ln.geometry === 'spatial_line') return { startZ: ln.startZ, endZ: ln.endZ };
  const b = parseFloat(ln.attrs.base_offset || '0') || 0;
  return {
    startZ: parseFloat(ln.attrs.start_z || `${b}`) || b,
    endZ: parseFloat(ln.attrs.end_z || `${b}`) || b,
  };
}

export function curveSection(ln: CanonicalElement): Section {
  const table = ln.tableName;
  const defaultShape = table === 'pipe' || table === 'conduit' ? 'round' : 'rect';
  const shape = (ln.attrs.shape || defaultShape) === 'round' ? 'round' : 'rect';
  const w = parseFloat(ln.attrs.size_x || '0.2') || 0.2;
  const h = shape === 'round' ? w : (parseFloat(ln.attrs.size_y || '0.2') || 0.2);
  return { shape, w, h };
}

/** Section axes for a member along model direction `d` (matches uprightAxisQuaternion). */
function modelSectionAxes(d: V3, rightHint?: V3): { right: V3; up: V3 } {
  let right: V3;
  if (Math.abs(d[2]) > 0.999) {
    right = rightHint ? norm([rightHint[0], rightHint[1], 0]) : [0, -1, 0];
    if (len(right) < 0.5) right = [0, -1, 0];
  } else {
    // world up × forward, written in model axes: (0,0,1) × d, rotated into the plan.
    right = norm([d[1], -d[0], 0]);
  }
  return { right, up: norm(cross(right, d)) };
}

/** Section extent of `leg` measured along direction `p`. */
function extentAlong(leg: { dir: V3; sec: Section }, p: V3, rightHint?: V3): number {
  const { right, up } = modelSectionAxes(leg.dir, rightHint);
  return Math.abs(dot(p, right)) * leg.sec.w + Math.abs(dot(p, up)) * leg.sec.h;
}

function bendRadiusFactor(table: string): number {
  switch (table) {
    case 'pipe': return 1.5;
    case 'conduit': return 4;
    default: return 1.0;
  }
}

function passiveNodes(ctx: GeometryContext): Map<string, PointElement> {
  const map = new Map<string, PointElement>();
  for (const el of ctx.elementsByTable('mep_node')) {
    if (el.geometry !== 'point') continue;
    if ((el.attrs.kind ?? '').trim()) continue;
    map.set(el.id, el as PointElement);
    const c = el.id.indexOf(':');
    if (c >= 0) map.set(el.id.substring(c + 1), el as PointElement);
  }
  return map;
}

interface RawLeg {
  curve: MepCurve;
  side: 'start' | 'end';
  end: V3;   // snapped end at the node
  far: V3;   // other end of the curve
}

export function analyzeFittings(ctx: GeometryContext): FittingAnalysis {
  return ctx.memo('mep:fittings', () => computeFittings(ctx));
}

function computeFittings(ctx: GeometryContext): FittingAnalysis {
  const nodes = passiveNodes(ctx);
  const ends = new Map<string, { start?: V3; end?: V3 }>();
  const riserRight = new Map<string, V3>();
  const byNode = new Map<string, FittingInfo>();
  if (nodes.size === 0) return { byNode, ends, riserRight };

  const rawByNode = new Map<string, RawLeg[]>();
  for (const table of MEP_LINE_TABLES) {
    for (const el of ctx.elementsByTable(table)) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const ln = el as MepCurve;
      const { startZ, endZ } = curveZ(ln);
      const s: V3 = [ln.start.x, ln.start.y, startZ];
      const e: V3 = [ln.end.x, ln.end.y, endZ];
      const cands: PointElement[] = [];
      for (const ref of [ln.attrs.from, ln.attrs.to]) {
        const p = parsePortRef(ref);
        const n = p ? nodes.get(p.hostId) : undefined;
        if (n) cands.push(n);
      }
      if (cands.length === 0) continue;
      const npos = (n: PointElement): V3 => [n.position.x, n.position.y, parseFloat(n.attrs.base_offset || '0') || 0];
      const d2 = (a: V3, n: PointElement) => Math.hypot(a[0] - n.position.x, a[1] - n.position.y);
      let atStart: PointElement | null = null, atEnd: PointElement | null = null;
      if (cands.length >= 2 && cands[0] !== cands[1]) {
        const [c0, c1] = cands;
        const direct = d2(s, c0) + d2(e, c1), swapped = d2(s, c1) + d2(e, c0);
        const [sc, ec] = direct <= swapped ? [c0, c1] : [c1, c0];
        if (d2(s, sc) < SNAP_TOL) atStart = sc;
        if (d2(e, ec) < SNAP_TOL) atEnd = ec;
      } else {
        const c = cands[0];
        // A riser referencing the same node twice is a data error: snap the nearer end only.
        if (d2(s, c) + Math.abs(s[2] - npos(c)[2]) <= d2(e, c) + Math.abs(e[2] - npos(c)[2])) { if (d2(s, c) < SNAP_TOL) atStart = c; }
        else if (d2(e, c) < SNAP_TOL) atEnd = c;
      }
      const snap = (p: V3, n: PointElement): V3 => {
        const np = npos(n);
        return [np[0], np[1], Math.abs(np[2] - p[2]) <= Z_SNAP_TOL ? np[2] : p[2]];
      };
      const sS = atStart ? snap(s, atStart) : s;
      const eS = atEnd ? snap(e, atEnd) : e;
      if (atStart) {
        const list = rawByNode.get(atStart.id) ?? [];
        list.push({ curve: ln, side: 'start', end: sS, far: eS });
        rawByNode.set(atStart.id, list);
      }
      if (atEnd) {
        const list = rawByNode.get(atEnd.id) ?? [];
        list.push({ curve: ln, side: 'end', end: eS, far: sS });
        rawByNode.set(atEnd.id, list);
      }
      ends.set(ln.id, { ...(atStart ? { start: sS } : {}), ...(atEnd ? { end: eS } : {}) });
    }
  }

  for (const [nodeId, raws] of rawByNode) {
    const node = nodes.get(nodeId)!;
    const legs: FittingLeg[] = [];
    let center: V3 = [node.position.x, node.position.y, parseFloat(node.attrs.base_offset || '0') || 0];
    if (raws.length > 0) center = [center[0], center[1], raws.reduce((s, r) => s + r.end[2], 0) / raws.length];
    for (const r of raws) {
      const v = sub(r.far, center);
      const l = len(v);
      if (l < 1e-6) continue;
      const sec = curveSection(r.curve);
      const dir = norm(v);
      legs.push({
        curveId: r.curve.id, table: r.curve.tableName, side: r.side, dir, sec,
        insulation: parseFloat(r.curve.attrs.insulation_thickness || '0') || 0,
        length: len(sub(r.far, r.end)), trim: 0,
        planWidth: Math.abs(dir[2]) > 0.999 ? sec.w : extentAlong({ dir, sec }, norm([-dir[1], dir[0], 0])),
      });
    }
    const info = classify(nodeId, node, center, legs);
    byNode.set(nodeId, info);
    // Width axis for risers: follow the horizontal run they join.
    const horiz = legs.find(l => Math.abs(l.dir[2]) < 0.5);
    if (horiz) for (const l of legs) if (Math.abs(l.dir[2]) > 0.999) riserRight.set(l.curveId, modelSectionAxes(horiz.dir).right);
  }

  // Apply trims to the effective ends.
  for (const info of byNode.values()) {
    for (const leg of info.legs) {
      if (leg.trim <= 1e-6) continue;
      const e = ends.get(leg.curveId) ?? {};
      const p = add(info.center, mul(leg.dir, leg.trim));
      if (leg.side === 'start') e.start = p; else e.end = p;
      ends.set(leg.curveId, e);
    }
  }
  return { byNode, ends, riserRight };
}

function classify(nodeId: string, node: PointElement, center: V3, legs: FittingLeg[]): FittingInfo {
  const hint = (node.attrs.fitting ?? '').trim();
  const system = node.attrs.system_type || '';
  const table = legs[0]?.table ?? 'pipe';
  const info: FittingInfo = { nodeId, center, kind: 'orphan', legs, radius: 0, main: null, system, table };
  const n = legs.length;
  if (n === 0) return info;
  const clampTrim = (leg: FittingLeg, t: number) => Math.max(0, Math.min(t, leg.length * 0.45));
  const collar = (leg: FittingLeg) => Math.max(0.025, 0.08 * Math.max(leg.sec.w, leg.sec.h));

  if (n === 1) { info.kind = hint === 'open' ? 'open' : 'cap'; return info; }

  if (n === 2) {
    const [a, b] = legs;
    const cosAB = dot(a.dir, b.dir);
    if (cosAB < STRAIGHT_DOT) {
      const sameShape = a.sec.shape === b.sec.shape;
      const sameSize = Math.abs(a.sec.w - b.sec.w) < 1e-3 && Math.abs(a.sec.h - b.sec.h) < 1e-3;
      if (sameShape && sameSize) { info.kind = 'coupling'; return info; }
      info.kind = sameShape ? 'reducer' : 'transition';
      const step = Math.max(Math.abs(a.sec.w - b.sec.w), Math.abs(a.sec.h - b.sec.h), 0.05);
      const L = Math.max(0.1, (step / 2) / Math.tan((20 * Math.PI) / 180));
      a.trim = clampTrim(a, L / 2);
      b.trim = clampTrim(b, L / 2);
      return info;
    }
    info.kind = 'elbow';
    const defl = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosAB)));
    const axis = norm(cross(a.dir, b.dir));
    const pA = norm(cross(axis, a.dir)), pB = norm(cross(axis, b.dir));
    const W = Math.max(extentAlong(a, pA), extentAlong(b, pB));
    let R = bendRadiusFactor(table) * W;
    const tanHalf = Math.tan(defl / 2);
    const maxT = Math.min(a.length, b.length) * 0.45;
    if (R * tanHalf > maxT) R = maxT / tanHalf;
    if (R < W / 2 + 1e-4) { info.radius = 0; return info; } // too tight: mitred corner
    info.radius = R;
    a.trim = b.trim = R * tanHalf;
    return info;
  }

  // 3+ legs: find the straightest pair as the main run.
  let best: [number, number] | null = null, bestDot = 1;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = dot(legs[i].dir, legs[j].dir);
    if (d < bestDot) { bestDot = d; best = [i, j]; }
  }
  const straight = best && bestDot < STRAIGHT_DOT ? best : null;
  if (n === 3 && straight) {
    const [i, j] = straight;
    const k = [0, 1, 2].find(x => x !== i && x !== j)!;
    const m1 = legs[i], m2 = legs[j], br = legs[k];
    info.main = [i, j];
    const mainBig = m1.sec.w * m1.sec.h >= m2.sec.w * m2.sec.h ? m1 : m2;
    const mainExt = extentAlong(mainBig, br.dir);
    const brExt = extentAlong(br, m1.dir);
    // Ducts: a small or round branch off a rectangular main is a tap
    // (spin-in / shoe), not a full tee — unless the node says otherwise.
    const autoTap = table === 'duct'
      && ((br.sec.shape === 'round' && mainBig.sec.shape === 'rect') || brExt <= 0.5 * mainBig.planWidth);
    const tap = hint === 'tap' || (hint !== 'tee' && autoTap);
    info.kind = tap ? 'tap' : 'tee';
    if (tap) {
      br.trim = clampTrim(br, mainExt / 2);
    } else {
      m1.trim = clampTrim(m1, brExt / 2 + collar(m1));
      m2.trim = clampTrim(m2, brExt / 2 + collar(m2));
      br.trim = clampTrim(br, mainExt / 2 + collar(br));
    }
    return info;
  }
  if (n === 4 && straight) {
    const [i, j] = straight;
    const rest = [0, 1, 2, 3].filter(x => x !== i && x !== j);
    const [k, l] = rest;
    if (dot(legs[k].dir, legs[l].dir) < STRAIGHT_DOT) {
      info.kind = 'cross';
      info.main = [i, j];
      const m = legs[i], b = legs[k];
      const mainExt = Math.max(extentAlong(legs[i], b.dir), extentAlong(legs[j], b.dir));
      const brExt = Math.max(extentAlong(legs[k], m.dir), extentAlong(legs[l], m.dir));
      for (const x of [i, j]) legs[x].trim = clampTrim(legs[x], brExt / 2 + collar(legs[x]));
      for (const x of [k, l]) legs[x].trim = clampTrim(legs[x], mainExt / 2 + collar(legs[x]));
      return info;
    }
  }
  info.kind = n === 3 ? 'wye' : n === 4 ? 'cross' : 'manifold';
  for (const leg of legs) {
    let ext = 0;
    for (const o of legs) if (o !== leg) ext = Math.max(ext, extentAlong(o, leg.dir));
    leg.trim = clampTrim(leg, ext / 2 + collar(leg));
  }
  return info;
}

/** Fitting kind for any mep_node (passive: analysed; accessory: its kind). */
export function fittingKindOf(nodeId: string, ctx: GeometryContext): FittingKind | null {
  return analyzeFittings(ctx).byNode.get(nodeId)?.kind ?? null;
}

/**
 * True when the curve's start continues a straight run of the same section
 * through a coupling / tee / cross (so a plan tag on the run's first
 * segment is enough).
 */
export function continuesStraight(analysis: FittingAnalysis, curveId: string, sameRun: (otherId: string) => boolean): boolean {
  for (const info of analysis.byNode.values()) {
    const i = info.legs.findIndex(l => l.curveId === curveId && l.side === 'start');
    if (i < 0) continue;
    if (info.kind === 'coupling') return sameRun(info.legs[1 - i].curveId);
    if (info.main && (info.main[0] === i || info.main[1] === i)) {
      const j = info.main[0] === i ? info.main[1] : info.main[0];
      return sameRun(info.legs[j].curveId);
    }
    return false;
  }
  return false;
}

/** Plan point helper. */
export const xy = (p: V3): Point => ({ x: p[0], y: p[1] });
