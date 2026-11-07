/**
 * Semantic reads of IFC shape representations: the `Axis` curve (wall /
 * railing location line, straight or circular) and the first extruded solid
 * of the `Body` (direction, depth and the swept profile's kind and sizes).
 * Everything comes back in world coordinates (IFC Z-up, meters).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc lines are untyped */
import type { IfcModel } from './model.js';
import { enumValue, num, str } from './model.js';
import { type Mat4, type V2, type V3, apply, applyDir, mul, norm3 } from './math.js';

export interface AxisCurve {
  /** World points of the location line (2 for a straight segment). */
  points: V3[];
  /** Set when the curve is a circular arc from points[0] to points[last]. */
  arc?: { center: V2; radius: number; ccw: boolean; sweepRad: number };
}

export type Profile =
  | { kind: 'rect'; x: number; y: number; hollow?: number }
  | { kind: 'circle'; r: number; hollow?: number }
  | { kind: 'i'; width: number; depth: number; web: number; flange: number }
  | { kind: 't'; width: number; depth: number; web: number; flange: number }
  | { kind: 'l'; width: number; depth: number; thickness: number }
  | { kind: 'c'; width: number; depth: number; web: number; flange: number }
  | { kind: 'polygon'; points: V2[] };

export interface Extrusion {
  /** World matrix of the solid's position (profile plane = local XY). */
  matrix: Mat4;
  /** World extrusion direction (unit). */
  dir: V3;
  depth: number;
  profile: Profile | null;
  /** World position of the profile's centre (its Position origin) at the start of the sweep. */
  origin: V3;
}

function representations(model: IfcModel, productId: number): any[] {
  const p = model.line(productId);
  const shape = model.ref(p?.Representation);
  return model.refs(shape?.Representations);
}

function repId(rep: any): string {
  return (str(rep?.RepresentationIdentifier) ?? '').toLowerCase();
}

// ─── Axis ────────────────────────────────────────────────────────────────────

export function axisCurve(model: IfcModel, productId: number): AxisCurve | null {
  const world = model.productMatrix(productId);
  if (!world) return null;
  for (const rep of representations(model, productId)) {
    if (repId(rep) !== 'axis') continue;
    for (const item of model.refs(rep.Items)) {
      const c = curve(model, item, world);
      if (c && c.points.length >= 2) return c;
    }
  }
  return null;
}

/** Closed plan curves of the `FootPrint` representation (spaces exported without a body). */
export function footprintRings(model: IfcModel, productId: number): V2[][] {
  const world = model.productMatrix(productId);
  if (!world) return [];
  const rings: V2[][] = [];
  for (const rep of representations(model, productId)) {
    if (repId(rep) !== 'footprint') continue;
    for (const item of model.refs(rep.Items)) {
      const curves = Array.isArray(item.Elements) ? model.refs(item.Elements) : [item];
      for (const c of curves) {
        const cv = curve(model, c, world);
        if (!cv || cv.points.length < 3) continue;
        const ring = cv.points.map(p => ({ x: p.x, y: p.y }));
        const first = ring[0], last = ring[ring.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) ring.pop();
        if (ring.length >= 3) rings.push(ring);
      }
    }
  }
  return rings;
}

function pt(model: IfcModel, attr: any): number[] {
  const l = model.ref(attr);
  const c = Array.isArray(l?.Coordinates) ? l.Coordinates : [];
  return c.map((x: any) => (num(x) ?? 0) * model.scale);
}

/** A curve entity (polyline, trimmed line / circle, composite, indexed) placed by `m`. */
export function curve(model: IfcModel, item: any, m: Mat4): AxisCurve | null {
  const cls = model.className(item.expressID);
  if (cls === 'IfcPolyline') {
    const pts = model.refs(item.Points).map(p => pt(model, p));
    return { points: pts.map(c => apply(m, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0)) };
  }
  if (cls === 'IfcTrimmedCurve') return trimmed(model, item, m);
  if (cls === 'IfcCompositeCurve') {
    const out: V3[] = [];
    let arc: AxisCurve['arc'];
    const segs = model.refs(item.Segments);
    for (const seg of segs) {
      const c = curve(model, model.ref(seg.ParentCurve), m);
      if (!c) continue;
      const sense = enumValue(seg.SameSense) !== 'F' && seg.SameSense?.value !== false;
      const pts = sense ? c.points : c.points.slice().reverse();
      for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-6) out.push(p);
      if (segs.length === 1 && c.arc) arc = sense ? c.arc : { ...c.arc, ccw: !c.arc.ccw };
    }
    return out.length >= 2 ? { points: out, arc } : null;
  }
  if (cls === 'IfcIndexedPolyCurve') {
    const list = model.ref(item.Points);
    const coords: number[][] = (list?.CoordList ?? []).map((row: any[]) => row.map(v => (num(v) ?? 0) * model.scale));
    return { points: coords.map(c => apply(m, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0)) };
  }
  if (cls === 'IfcLine') {
    const p0 = pt(model, item.Pnt);
    const dir = model.ref(item.Dir);
    const d = model.ref(dir?.Orientation)?.DirectionRatios?.map((x: any) => num(x) ?? 0) ?? [1, 0, 0];
    const mag = (num(dir?.Magnitude) ?? 1) * model.scale;
    return {
      points: [apply(m, p0[0] ?? 0, p0[1] ?? 0, p0[2] ?? 0), apply(m, (p0[0] ?? 0) + d[0] * mag, (p0[1] ?? 0) + (d[1] ?? 0) * mag, (p0[2] ?? 0) + (d[2] ?? 0) * mag)],
    };
  }
  return null;
}

function trimmed(model: IfcModel, item: any, m: Mat4): AxisCurve | null {
  const basis = model.ref(item.BasisCurve);
  if (!basis) return null;
  const cls = model.className(basis.expressID);
  const sense = item.SenseAgreement?.value !== false && enumValue(item.SenseAgreement) !== 'F';
  const trimPoint = (trims: any[]): number[] | null => {
    for (const t of trims ?? []) {
      const l = model.ref(t);
      if (l && Array.isArray(l.Coordinates)) return pt(model, l);
    }
    return null;
  };
  const trimParam = (trims: any[]): number | null => {
    for (const t of trims ?? []) {
      if (t && typeof t === 'object' && t.type !== 5 && typeof t.value === 'number') return t.value;
    }
    return null;
  };
  if (cls === 'IfcLine') {
    const p0 = pt(model, basis.Pnt);
    const vec = model.ref(basis.Dir);
    const d = model.ref(vec?.Orientation)?.DirectionRatios?.map((x: any) => num(x) ?? 0) ?? [1, 0, 0];
    const mag = num(vec?.Magnitude) ?? 1;
    const at = (t: number) => [(p0[0] ?? 0) + d[0] * mag * t * model.scale, (p0[1] ?? 0) + (d[1] ?? 0) * mag * t * model.scale, (p0[2] ?? 0) + (d[2] ?? 0) * mag * t * model.scale];
    const a = trimPoint(item.Trim1) ?? at(trimParam(item.Trim1) ?? 0);
    const b = trimPoint(item.Trim2) ?? at(trimParam(item.Trim2) ?? 1);
    // The trimmed curve always runs Trim1 → Trim2 (SenseAgreement only says which way round the basis).
    return { points: [apply(m, a[0], a[1], a[2] ?? 0), apply(m, b[0], b[1], b[2] ?? 0)] };
  }
  if (cls === 'IfcCircle') {
    const r = (num(basis.Radius) ?? 0) * model.scale;
    const cm = mul(m, model.axisPlacement(basis.Position));
    // Parameters are angles (plane angle unit: assume degrees when > 2π is seen)
    const p1 = trimParam(item.Trim1), p2 = trimParam(item.Trim2);
    const local = (deg: number) => {
      const a = angleUnit(deg, p1, p2);
      return apply(cm, r * Math.cos(a), r * Math.sin(a), 0);
    };
    const tp1 = trimPoint(item.Trim1), tp2 = trimPoint(item.Trim2);
    const s = tp1 ? apply(m, tp1[0], tp1[1], tp1[2] ?? 0) : p1 !== null ? local(p1) : null;
    const e = tp2 ? apply(m, tp2[0], tp2[1], tp2[2] ?? 0) : p2 !== null ? local(p2) : null;
    if (!s || !e) return null;
    const center = apply(cm, 0, 0, 0);
    // The circle's local Z decides whether increasing angle is CCW in plan.
    const zUp = applyDir(cm, 0, 0, 1).z >= 0;
    // Trim1 → Trim2, with increasing parameter (CCW locally) when the sense agrees.
    const ccw = zUp ? sense : !sense;
    const a0 = Math.atan2(s.y - center.y, s.x - center.x), a1 = Math.atan2(e.y - center.y, e.x - center.x);
    let sweep = ccw ? a1 - a0 : a0 - a1;
    while (sweep <= 1e-9) sweep += 2 * Math.PI;
    return { points: [s, e], arc: { center: { x: center.x, y: center.y }, radius: r, ccw, sweepRad: sweep } };
  }
  return null;
}

function angleUnit(v: number, p1: number | null, p2: number | null): number {
  const big = Math.max(Math.abs(p1 ?? 0), Math.abs(p2 ?? 0)) > 2 * Math.PI + 1e-6;
  return big ? (v * Math.PI) / 180 : v;
}

// ─── Extrusion ───────────────────────────────────────────────────────────────

/** First extruded solid of the Body representation (through booleans and mapped items). */
export function extrusion(model: IfcModel, productId: number): Extrusion | null {
  const world = model.productMatrix(productId);
  if (!world) return null;
  const reps = representations(model, productId);
  const body = reps.filter(r => repId(r) === 'body' || repId(r) === '');
  for (const rep of body.length ? body : reps) {
    for (const item of model.refs(rep.Items)) {
      const e = findExtrusion(model, item, world, 0);
      if (e) return e;
    }
  }
  return null;
}

function findExtrusion(model: IfcModel, item: any, m: Mat4, depth: number): Extrusion | null {
  if (!item || depth > 6) return null;
  const cls = model.className(item.expressID);
  if (cls === 'IfcExtrudedAreaSolid' || cls === 'IfcExtrudedAreaSolidTapered') {
    const sm = mul(m, model.axisPlacement(item.Position));
    const dRatios = model.ref(item.ExtrudedDirection)?.DirectionRatios?.map((x: any) => num(x) ?? 0) ?? [0, 0, 1];
    const dir = norm3(applyDir(sm, dRatios[0] ?? 0, dRatios[1] ?? 0, dRatios[2] ?? 1));
    const area = model.ref(item.SweptArea);
    const prof = profile(model, area);
    const pm = profilePlacement(model, area);
    return {
      matrix: sm,
      dir,
      depth: (num(item.Depth) ?? 0) * model.scale,
      profile: prof,
      origin: apply(sm, pm.x, pm.y, 0),
    };
  }
  if (cls === 'IfcBooleanResult' || cls === 'IfcBooleanClippingResult') {
    return findExtrusion(model, model.ref(item.FirstOperand), m, depth + 1);
  }
  if (cls === 'IfcMappedItem') {
    const src = model.ref(item.MappingSource);
    const target = cartesianOperator(model, model.ref(item.MappingTarget));
    const origin = model.axisPlacement(src?.MappingOrigin);
    const mm = mul(mul(m, target), origin);
    const rep = model.ref(src?.MappedRepresentation);
    for (const sub of model.refs(rep?.Items)) {
      const e = findExtrusion(model, sub, mm, depth + 1);
      if (e) return e;
    }
  }
  return null;
}

function profilePlacement(model: IfcModel, area: any): V2 {
  const pos = model.ref(area?.Position);
  const loc = model.ref(pos?.Location)?.Coordinates;
  if (!Array.isArray(loc)) return { x: 0, y: 0 };
  return { x: (num(loc[0]) ?? 0) * model.scale, y: (num(loc[1]) ?? 0) * model.scale };
}

function cartesianOperator(model: IfcModel, op: any): Mat4 {
  const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!op) return I;
  const dir = (a: any, d: number[]) => model.ref(a)?.DirectionRatios?.map((x: any) => num(x) ?? 0) ?? d;
  const x = dir(op.Axis1, [1, 0, 0]);
  const y = dir(op.Axis2, [0, 1, 0]);
  const z = dir(op.Axis3, [0, 0, 1]);
  const o = model.ref(op.LocalOrigin)?.Coordinates?.map((c: any) => (num(c) ?? 0) * model.scale) ?? [0, 0, 0];
  const s = num(op.Scale) ?? 1;
  return [x[0] * s, x[1] * s, (x[2] ?? 0) * s, 0, y[0] * s, y[1] * s, (y[2] ?? 0) * s, 0, (z[0] ?? 0) * s, (z[1] ?? 0) * s, (z[2] ?? 1) * s, 0, o[0] ?? 0, o[1] ?? 0, o[2] ?? 0, 1];
}

/** Profile kind and sizes (meters). */
export function profile(model: IfcModel, p: any): Profile | null {
  if (!p) return null;
  const cls = model.className(p.expressID);
  const L = (a: any) => (num(a) ?? 0) * model.scale;
  switch (cls) {
    case 'IfcRectangleProfileDef':
    case 'IfcRoundedRectangleProfileDef':
      return { kind: 'rect', x: L(p.XDim), y: L(p.YDim) };
    case 'IfcRectangleHollowProfileDef':
      return { kind: 'rect', x: L(p.XDim), y: L(p.YDim), hollow: L(p.WallThickness) };
    case 'IfcCircleProfileDef':
      return { kind: 'circle', r: L(p.Radius) };
    case 'IfcCircleHollowProfileDef':
      return { kind: 'circle', r: L(p.Radius), hollow: L(p.WallThickness) };
    case 'IfcIShapeProfileDef':
    case 'IfcAsymmetricIShapeProfileDef':
      return { kind: 'i', width: L(p.OverallWidth ?? p.BottomFlangeWidth), depth: L(p.OverallDepth), web: L(p.WebThickness), flange: L(p.FlangeThickness ?? p.BottomFlangeThickness) };
    case 'IfcTShapeProfileDef':
      return { kind: 't', width: L(p.FlangeWidth), depth: L(p.Depth), web: L(p.WebThickness), flange: L(p.FlangeThickness) };
    case 'IfcLShapeProfileDef':
      return { kind: 'l', width: L(p.Width ?? p.Depth), depth: L(p.Depth), thickness: L(p.Thickness) };
    case 'IfcUShapeProfileDef':
      return { kind: 'c', width: L(p.FlangeWidth), depth: L(p.Depth), web: L(p.WebThickness), flange: L(p.FlangeThickness) };
    case 'IfcCShapeProfileDef':
      return { kind: 'c', width: L(p.Width), depth: L(p.Depth), web: L(p.WallThickness), flange: L(p.WallThickness) };
    case 'IfcArbitraryClosedProfileDef':
    case 'IfcArbitraryProfileDefWithVoids': {
      const outer = model.ref(p.OuterCurve);
      const c = outer ? curve(model, outer, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) : null;
      return c ? { kind: 'polygon', points: c.points.map(q => ({ x: q.x, y: q.y })) } : null;
    }
    case 'IfcDerivedProfileDef':
      return profile(model, model.ref(p.ParentProfile));
    default:
      return null;
  }
}
