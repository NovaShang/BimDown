/**
 * Fitting and accessory bodies, 2D and 3D.
 *
 * Passive fittings (analysis in fittings.ts): radiused elbows, tees and
 * crosses with collars, taps, reducer / transition cones, caps. Accessories
 * (valves, dampers, …): plan symbol across the run and a simple 3D body.
 */
import { useMemo } from 'react';
import { BufferGeometry, CylinderGeometry, BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import type { FittingInfo, FittingLeg } from './fittings.ts';
import { add, dirToWorld, elbowBody, loftBody, mergeGeometries, mul, norm, straightBody, toWorld, type V3, type Section } from './geom3d.ts';
import { useMepView, isolateOpacity, inSystem } from './mepView.ts';
import { ghostMaterial, solidMaterial } from './materials.ts';
import { getSystemColorMaterial } from '../three/utils/bimMaterials.ts';
import { accessorySymbol, ProblemMarkers } from './planSymbols.tsx';

type P = { x: number; y: number };

const isHoriz = (l: FittingLeg) => Math.abs(l.dir[2]) < 0.5;
const planDir = (l: FittingLeg): P => { const h = Math.hypot(l.dir[0], l.dir[1]) || 1; return { x: l.dir[0] / h, y: l.dir[1] / h }; };

/** Rectangle from `a` along `u` by `length`, `width` wide. */
function band(a: P, u: P, length: number, width: number): P[] {
  const n = { x: -u.y, y: u.x }, hw = width / 2;
  const b = { x: a.x + u.x * length, y: a.y + u.y * length };
  return [
    { x: a.x + n.x * hw, y: a.y + n.y * hw }, { x: b.x + n.x * hw, y: b.y + n.y * hw },
    { x: b.x - n.x * hw, y: b.y - n.y * hw }, { x: a.x - n.x * hw, y: a.y - n.y * hw },
  ];
}

/** Parts of segment a→b outside convex polygon `poly`. */
function outsideConvex(a: P, b: P, poly: P[]): [P, P][] {
  let t0 = 0, t1 = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  // Orientation of the polygon.
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p.x * q.y - q.x * p.y; }
  const s = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    // Inward normal.
    const nx = -(q.y - p.y) * s, ny = (q.x - p.x) * s;
    const num = (a.x - p.x) * nx + (a.y - p.y) * ny;
    const den = d.x * nx + d.y * ny;
    if (Math.abs(den) < 1e-12) { if (num < 1e-9) return [[a, b]]; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1 - 1e-9) return [[a, b]];
  }
  const at = (t: number): P => ({ x: a.x + d.x * t, y: a.y + d.y * t });
  const out: [P, P][] = [];
  if (t0 > 1e-6) out.push([a, at(t0)]);
  if (t1 < 1 - 1e-6) out.push([at(t1), b]);
  return out;
}

interface Plan2D { fills: P[][]; edges: [P, P][] }

/** Plan outline of a passive fitting: filled body + outline edges. */
export function fittingPlan(info: FittingInfo): Plan2D {
  const c: P = { x: info.center[0], y: info.center[1] };
  const fills: P[][] = [];
  const edges: [P, P][] = [];
  const legs = info.legs;
  if (info.kind === 'elbow' && info.radius > 0) {
    const h = legs.filter(isHoriz);
    if (h.length === 2) {
      const [a, b] = h;
      const da = planDir(a), db = planDir(b);
      const cosT = Math.max(-1, Math.min(1, da.x * db.x + da.y * db.y));
      const defl = Math.PI - Math.acos(cosT);
      if (defl > 1e-3) {
        const R = a.trim / Math.tan(defl / 2);
        const bis = norm([da.x + db.x, da.y + db.y, 0]);
        const o = { x: c.x + bis[0] * R / Math.cos(defl / 2), y: c.y + bis[1] * R / Math.cos(defl / 2) };
        const ta = { x: c.x + da.x * a.trim, y: c.y + da.y * a.trim };
        const tb = { x: c.x + db.x * b.trim, y: c.y + db.y * b.trim };
        const e1 = { x: (ta.x - o.x) / R, y: (ta.y - o.y) / R };
        const e2 = { x: (tb.x - o.x) / R, y: (tb.y - o.y) / R };
        const W = Math.max(a.planWidth, b.planWidth);
        const N = 14;
        const sweep = Math.atan2(e1.x * e2.y - e1.y * e2.x, e1.x * e2.x + e1.y * e2.y);
        const a0 = Math.atan2(e1.y, e1.x);
        const arc = (r: number) => Array.from({ length: N + 1 }, (_, i) => {
          const ang = a0 + (sweep * i) / N;
          return { x: o.x + Math.cos(ang) * r, y: o.y + Math.sin(ang) * r };
        });
        const outer = arc(R + W / 2), inner = arc(Math.max(R - W / 2, 0));
        fills.push([...outer, ...inner.reverse()]);
        const inn = [...inner].reverse();
        for (let i = 0; i < N; i++) { edges.push([outer[i], outer[i + 1]]); edges.push([inn[i], inn[i + 1]]); }
        edges.push([outer[0], inn[0]], [outer[N], inn[N]]);
      }
    } else if (h.length === 1) {
      // Vertical bend: plan shows the horizontal arm up to the riser.
      const a = h[0];
      const p = band(c, planDir(a), a.trim, a.planWidth);
      fills.push(p);
      edges.push([p[0], p[1]], [p[1], p[2]], [p[2], p[3]]);
    }
    return { fills, edges };
  }
  if (info.kind === 'reducer' || info.kind === 'transition') {
    const [a, b] = legs;
    if (!isHoriz(a) || !isHoriz(b)) return { fills, edges };
    const da = planDir(a);
    const n = { x: -da.y, y: da.x };
    const pa = { x: c.x + da.x * a.trim, y: c.y + da.y * a.trim };
    const db = planDir(b);
    const pb = { x: c.x + db.x * b.trim, y: c.y + db.y * b.trim };
    const q = [
      { x: pa.x + n.x * a.planWidth / 2, y: pa.y + n.y * a.planWidth / 2 },
      { x: pb.x + n.x * b.planWidth / 2, y: pb.y + n.y * b.planWidth / 2 },
      { x: pb.x - n.x * b.planWidth / 2, y: pb.y - n.y * b.planWidth / 2 },
      { x: pa.x - n.x * a.planWidth / 2, y: pa.y - n.y * a.planWidth / 2 },
    ];
    fills.push(q);
    edges.push([q[0], q[1]], [q[2], q[3]], [q[1], q[2]], [q[3], q[0]]);
    return { fills, edges };
  }
  if (info.kind === 'cap' && legs[0] && isHoriz(legs[0])) {
    const d = planDir(legs[0]);
    const p = band({ x: c.x - d.x * 0.02, y: c.y - d.y * 0.02 }, d, 0.02, legs[0].planWidth * 1.06);
    fills.push(p);
    edges.push([p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]);
    return { fills, edges };
  }
  if (info.kind === 'tee' || info.kind === 'cross' || info.kind === 'wye' || info.kind === 'manifold') {
    const bands = legs.filter(l => isHoriz(l) && l.trim > 1e-4).map(l => ({ leg: l, poly: band(c, planDir(l), l.trim, l.planWidth) }));
    for (const b of bands) {
      fills.push(b.poly);
      // Long sides, clipped where they run inside another arm; the far end is the connector face.
      const sides: [P, P][] = [[b.poly[0], b.poly[1]], [b.poly[3], b.poly[2]], [b.poly[1], b.poly[2]]];
      for (const s of sides) {
        let pieces: [P, P][] = [s];
        for (const o of bands) {
          if (o === b) continue;
          pieces = pieces.flatMap(([p, q]) => outsideConvex(p, q, o.poly));
        }
        edges.push(...pieces);
      }
    }
    return { fills, edges };
  }
  return { fills, edges };
}

export function Fitting2D({ info, id, color, selected }: { info: FittingInfo; id: string; color: string; selected: boolean }) {
  const view = useMepView();
  const plan = useMemo(() => fittingPlan(info), [info]);
  const markers = view.showProblems ? view.problemMarkers.get(id) : undefined;
  if (plan.fills.length === 0 && !markers) return null;
  const stroke = selected ? '#3a7bff' : color;
  const sw = info.table === 'duct' || info.table === 'cable_tray' ? 0.025 : 0.02;
  return (
    <g data-id={id} opacity={isolateOpacity(view, info.system)}>
      {plan.fills.map((poly, i) => (
        <polygon key={`f${i}`} points={poly.map(p => `${p.x},${p.y}`).join(' ')} fill={stroke + '22'} stroke="none" data-id={id} />
      ))}
      {plan.edges.map(([a, b], i) => (
        <line key={`e${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={sw} data-id={id} />
      ))}
      {markers && <ProblemMarkers points={markers} />}
    </g>
  );
}

function sectionOf(l: FittingLeg, scale = 1): Section {
  return { shape: l.sec.shape, w: l.sec.w * scale, h: l.sec.h * scale };
}

/** Three.js geometry for a passive fitting (world frame). */
export function fittingGeometry(info: FittingInfo, baseY: number, riserRight: Map<string, V3>): BufferGeometry | null {
  const cW = toWorld(info.center, baseY);
  const hintOf = (l: FittingLeg): V3 | undefined => {
    const h = riserRight.get(l.curveId);
    return h ? dirToWorld(h) : undefined;
  };
  const endOf = (l: FittingLeg, extra = 0): V3 => add(cW, mul(dirToWorld(l.dir), l.trim + extra));
  const legs = info.legs;
  const parts: (BufferGeometry | null)[] = [];
  switch (info.kind) {
    case 'elbow': {
      if (info.radius <= 0) return null;
      // Sweep from the horizontal leg so the section matches the duct extrusion.
      const [a, b] = isHoriz(legs[0]) || !isHoriz(legs[1]) ? [legs[0], legs[1]] : [legs[1], legs[0]];
      parts.push(elbowBody(cW, dirToWorld(a.dir), dirToWorld(b.dir), info.radius, sectionOf(a), hintOf(a)));
      break;
    }
    case 'reducer':
    case 'transition': {
      const [a, b] = legs;
      parts.push(loftBody(endOf(a), endOf(b), sectionOf(a), sectionOf(b), hintOf(a) ?? hintOf(b)));
      break;
    }
    case 'tap': {
      const br = legs.find((_, i) => !info.main || (i !== info.main[0] && i !== info.main[1]));
      if (br) parts.push(straightBody(endOf(br, -0.01), endOf(br, 0.05), sectionOf(br, 1.08), hintOf(br)));
      break;
    }
    case 'cap': {
      const l = legs[0];
      if (l) parts.push(straightBody(cW, add(cW, mul(dirToWorld(l.dir), -0.02)), sectionOf(l, 1.04), hintOf(l)));
      break;
    }
    case 'tee':
    case 'cross':
    case 'wye':
    case 'manifold':
      for (const l of legs) {
        if (l.trim <= 1e-4) continue;
        parts.push(straightBody(cW, endOf(l), sectionOf(l), hintOf(l)));
        if (info.table === 'duct') parts.push(straightBody(endOf(l, -0.03), endOf(l), sectionOf(l, 1.06), hintOf(l)));
      }
      break;
    default:
      return null;
  }
  return mergeGeometries(parts);
}

export function Fitting3D({ info, id, color, baseY, riserRight, isHL }: {
  info: FittingInfo; id: string; color: string; baseY: number; riserRight: Map<string, V3>; isHL: boolean;
}) {
  const view = useMepView();
  const geo = useMemo(() => fittingGeometry(info, baseY, riserRight), [info, baseY, riserRight]);
  if (!geo) return null;
  const ghost = isolateOpacity(view, info.system) < 1;
  const material = ghost ? ghostMaterial(color) : getSystemColorMaterial(color);
  return (
    <mesh geometry={geo} material={isHL ? undefined : material} userData={{ elementId: id }}>
      {isHL && <meshStandardMaterial attach="material" color="#06b6d4" />}
    </mesh>
  );
}

// ─── Accessories ───────────────────────────────────────────────────────────

export interface AccessoryLook {
  kind: string;
  /** Plan position and run direction (unit, plan). */
  at: P;
  dir: P;
  /** 3D run direction (model). */
  dir3: V3;
  z: number;
  /** Body length along the run and size across it. */
  length: number;
  width: number;
  height: number;
  round: boolean;
}

/** Default body length for an inline accessory on a run of size `w`. */
export function accessoryLength(kind: string, table: string, w: number): number {
  if (table === 'duct') return kind === 'fire_damper' ? 0.3 : 0.2;
  if (kind === 'flow_meter' || kind === 'strainer') return Math.max(0.2, Math.min(0.6, w * 4));
  return Math.max(0.15, Math.min(0.5, w * 3));
}

export function Accessory2D({ look, id, color, selected, system }: { look: AccessoryLook; id: string; color: string; selected: boolean; system: string }) {
  const view = useMepView();
  const stroke = selected ? '#3a7bff' : color;
  const ang = (Math.atan2(look.dir.y, look.dir.x) * 180) / Math.PI;
  const H = Math.max(look.width * (look.kind.includes('damper') ? 1 : 1.6), 0.09);
  const markers = view.showProblems ? view.problemMarkers.get(id) : undefined;
  return (
    <g data-id={id} opacity={isolateOpacity(view, system)}>
      <g transform={`translate(${look.at.x},${look.at.y}) rotate(${ang})`} data-id={id}>
        {accessorySymbol(look.kind, look.length, H, stroke, '#ffffff')}
        {/* Always-clickable hit zone */}
        <rect x={-look.length / 2} y={-H / 2} width={look.length} height={H} fill="transparent" data-id={id} />
      </g>
      {markers && <ProblemMarkers points={markers} />}
      {view.highlight && inSystem(system, view.highlight) && (
        <circle cx={look.at.x} cy={look.at.y} r={look.length} fill="none" stroke={stroke} strokeWidth={0.1} strokeOpacity={0.3} />
      )}
    </g>
  );
}

function accessoryGeometry(look: AccessoryLook): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const L = look.length, r = look.width / 2;
  if (look.kind.includes('damper')) {
    out.push(new BoxGeometry(L, look.round ? look.width * 1.08 : look.height * 1.08, look.width * 1.08));
    const shaft = new CylinderGeometry(0.012, 0.012, look.width * 1.3, 8);
    shaft.rotateX(Math.PI / 2);
    out.push(shaft);
    return out;
  }
  if (look.kind === 'flow_meter' || look.kind === 'sensor') {
    out.push(new CylinderGeometry(r * 1.4, r * 1.4, L, 16).rotateZ(Math.PI / 2));
    return out;
  }
  // Valve: two cones meeting at the centre, a stem and a handle.
  const cone = (s: number) => {
    const g = new CylinderGeometry(0.15 * r, r * 1.35, L / 2, 16);
    // Small end at the centre, full size at the pipe ends (bow-tie).
    g.rotateZ(-s * Math.PI / 2);
    g.translate(-s * L / 4, 0, 0);
    return g;
  };
  out.push(cone(1), cone(-1));
  if (look.kind !== 'check_valve') {
    const stemH = Math.max(0.08, r * 2.5);
    out.push(new CylinderGeometry(r * 0.18, r * 0.18, stemH, 8).translate(0, stemH / 2, 0));
    out.push(new BoxGeometry(Math.max(0.1, r * 3), 0.015, 0.03).translate(0, stemH, 0));
  }
  return out;
}

export function Accessory3D({ look, id, color, baseY, isHL, system }: { look: AccessoryLook; id: string; color: string; baseY: number; isHL: boolean; system: string }) {
  const view = useMepView();
  const geos = useMemo(() => accessoryGeometry(look), [look]);
  const quat = useMemo(() => {
    const f = new Vector3(look.dir3[0], look.dir3[2], -look.dir3[1]).normalize();
    let up = new Vector3(0, 1, 0);
    if (Math.abs(f.dot(up)) > 0.999) up = new Vector3(0, 0, 1);
    const side = new Vector3().crossVectors(f, up).normalize();
    const up2 = new Vector3().crossVectors(side, f).normalize();
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(f, up2, side));
  }, [look]);
  const ghost = isolateOpacity(view, system) < 1;
  const tint = look.kind === 'fire_damper' ? '#d33' : color;
  const material = ghost ? ghostMaterial(tint) : solidMaterial(tint, 0.4);
  return (
    <group position={[look.at.x, baseY + look.z, -look.at.y]} quaternion={quat} userData={{ elementId: id }}>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} material={isHL ? undefined : material} userData={{ elementId: id }}>
          {isHL && <meshStandardMaterial attach="material" color="#06b6d4" />}
        </mesh>
      ))}
    </group>
  );
}
