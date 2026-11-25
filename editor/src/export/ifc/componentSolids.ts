/**
 * World-frame solids of library furniture and MEP runs / fittings /
 * accessories, the same bodies the 3D view draws. Shared by the IFC exporter
 * and the section / elevation drawings.
 */
import { Matrix4, type BufferGeometry } from 'three';
import type { CanonicalElement, LineElement, SpatialLineElement } from '../../model/elements.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import type { FurnitureFacts } from '../../elements/furniture.tsx';
import type { MepNodeFacts } from '../../elements/mep_node.tsx';
import { furnitureMass, type MassColor } from '../../library/furnitureLibrary.ts';
import { furniturePartGeometry } from '../../library/furniture3D.ts';
import { effectiveMepLine } from '../../model/mepFittingRender.ts';
import { accessoryBasis, accessoryGeometry, fittingGeometry, type AccessoryLook } from '../../mep/FittingView.tsx';
import type { FittingInfo, FittingLeg } from '../../mep/fittings.ts';
import { dirToWorld, sectionFrame, type V3 as M3 } from '../../mep/geom3d.ts';
import { type Frame, type Profile, type Solid, type V2, type V3, add, cross, dot, length, normalize, planFrame, scale, sub, v3 } from './frame.ts';
import { box, brepFromBuffer, sweep } from './geometry.ts';

/** A three.js world-frame geometry as one faceted brep (consumes the geometry). */
export function threeSolid(geo: BufferGeometry | null): Solid | null {
  if (!geo) return null;
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const solid = brepFromBuffer(flat);
  if (flat !== geo) flat.dispose();
  geo.dispose();
  return solid;
}

/** Furniture mass parts: boxes and upright cylinders extruded, cones / spheres as breps; with each part's colour. */
export function furnitureSolids(f: FurnitureFacts): { solid: Solid; color: MassColor }[] {
  const th = (f.rotationDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const toWorld = (x: number, y: number): V2 => ({ x: f.position.x + x * c - y * s, y: f.position.y + x * s + y * c });
  const out: { solid: Solid; color: MassColor }[] = [];
  for (const m of furnitureMass(f.resolved)) {
    let solid: Solid | null;
    if (m.k === 'box') {
      solid = box(toWorld(m.x, m.y), f.baseY + m.z, m.w, m.d, m.h, th);
    } else if (m.k === 'cyl' && m.rx === m.ry && (m.top ?? 1) === 1) {
      const p = toWorld(m.x, m.y);
      solid = { kind: 'extrude', profile: { kind: 'circle', r: m.rx }, frame: planFrame(v3(p.x, p.y, f.baseY + m.z), th), depth: m.h };
    } else {
      const g = furniturePartGeometry(m);
      g.rotateY(th);
      g.translate(f.position.x, f.baseY, -f.position.y);
      solid = threeSolid(g);
    }
    if (solid && (m.k === 'sph' || m.h > 1e-6)) out.push({ solid, color: m.c });
  }
  return out;
}

/** An MEP run as drawn: ends on their fitting nodes, pulled back to the fitting faces. */
export function mepRun(el: CanonicalElement, ctx: GeometryContext): { start: V3; end: V3; round: boolean; sizeX: number; sizeY: number } | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const eff = effectiveMepLine(el as LineElement | SpatialLineElement, ctx);
  const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
  let startZ: number, endZ: number;
  if (eff.geometry === 'spatial_line') { startZ = (eff as SpatialLineElement).startZ; endZ = (eff as SpatialLineElement).endZ; }
  else { const base = num(el.attrs.base_offset); startZ = num(el.attrs.start_z, base); endZ = num(el.attrs.end_z, startZ); }
  const start = v3(eff.start.x, eff.start.y, ctx.levelElevation + startZ);
  const end = v3(eff.end.x, eff.end.y, ctx.levelElevation + endZ);
  if (length(sub(end, start)) < 1e-3 * ctx.unitsPerMetre) return null;
  const round = (el.attrs.shape || (el.tableName === 'pipe' || el.tableName === 'conduit' ? 'round' : 'rect')) === 'round';
  const sizeX = num(el.attrs.size_x) || 0.2 * ctx.unitsPerMetre;
  return { start, end, round, sizeX, sizeY: round ? sizeX : num(el.attrs.size_y) || 0.2 * ctx.unitsPerMetre };
}

/** The run's body (section swept along it). */
export function mepRunSolid(el: CanonicalElement, ctx: GeometryContext): Solid | null {
  const r = mepRun(el, ctx);
  if (!r) return null;
  return sweep(r.start, r.end, r.round ? { kind: 'circle', r: r.sizeX / 2 } : { kind: 'rect', w: r.sizeX, d: r.sizeY });
}

const fromWorld = (d: M3): V3 => ({ x: d[0], y: -d[2], z: d[1] });
const m3 = (v: M3): V3 => ({ x: v[0], y: v[1], z: v[2] });

/** Section frame of a leg running along model `dir` (the 3D view's: width along `right`). */
function legFrame(o: V3, dir: V3, hint?: M3): Frame {
  const f = sectionFrame(dirToWorld([dir.x, dir.y, dir.z]), hint ? dirToWorld(hint) : undefined);
  return { o, z: dir, x: fromWorld(f.right) };
}

function legProfile(l: FittingLeg, k = 1): Profile {
  return l.sec.shape === 'round' ? { kind: 'circle', r: (l.sec.w * k) / 2 } : { kind: 'rect', w: l.sec.w * k, d: l.sec.h * k };
}

/**
 * Lightweight IFC body of a passive fitting, the same shape the 3D view
 * draws: an elbow is the section revolved about the bend axis (a light
 * faceted bend with exact end faces, or an IfcRevolvedAreaSolid for a section
 * small enough that a viewer's chording can't show), tee / cross / wye arms, taps and caps are short
 * extrusions; null for reducers / transitions (a small faceted loft).
 * A large imported model has thousands of fittings: faceted breps of their
 * swept bodies made a 13 MB IFC 81 MB.
 */
export function fittingIfcSolids(info: FittingInfo, levelY: number, riserRight: Map<string, M3>): Solid[] | null {
  const c = v3(info.center[0], info.center[1], info.center[2] + levelY);
  const hint = (l: FittingLeg) => riserRight.get(l.curveId);
  const dirOf = (l: FittingLeg) => normalize(m3(l.dir));
  const isHoriz = (l: FittingLeg) => Math.abs(l.dir[2]) < 0.5;
  const straight = (l: FittingLeg, from: number, to: number, k = 1): Solid | null => {
    if (to - from < 1e-4) return null;
    const d = dirOf(l);
    return { kind: 'extrude', profile: legProfile(l, k), frame: legFrame(add(c, scale(d, from)), d, hint(l)), depth: to - from };
  };
  const out: (Solid | null)[] = [];
  switch (info.kind) {
    case 'elbow': {
      if (info.radius <= 0) return [];
      const [a, b] = isHoriz(info.legs[0]) || !isHoriz(info.legs[1]) ? [info.legs[0], info.legs[1]] : [info.legs[1], info.legs[0]];
      const da = dirOf(a), db = dirOf(b);
      const defl = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(da, db))));
      if (defl < 1e-3) return [];
      const R = info.radius;
      const ta = add(c, scale(da, R * Math.tan(defl / 2)));
      const centre = add(c, scale(normalize(add(da, db)), R / Math.cos(defl / 2)));
      const inward = normalize(sub(centre, ta));
      let k = normalize(cross(da, db));
      // Turn so that ta moves along the flow (−da) first
      if (dot(cross(k, scale(inward, -1)), scale(da, -1)) < 0) k = scale(k, -1);
      const sec = legFrame(ta, scale(da, -1), hint(a));
      // Profile plane at ta: X towards the bend centre, Z along the flow
      const z = scale(da, -1), x = inward, y = cross(z, x);
      const frame: Frame = { o: ta, z, x };
      let profile: Profile;
      if (a.sec.shape === 'round') profile = { kind: 'circle', r: a.sec.w / 2 };
      else {
        const right = sec.x, up = cross(sec.z, sec.x);
        const hw = a.sec.w / 2, hh = a.sec.h / 2;
        const corner = (sx: number, sy: number) => {
          const p = add(scale(right, sx * hw), scale(up, sy * hh));
          return { x: dot(p, x), y: dot(p, y) };
        };
        const c0 = corner(1, 1);
        // Section square to the bend plane (always, for drawn runs): a rectangle profile
        if (Math.abs(Math.abs(dot(right, x)) - 1) < 1e-6 || Math.abs(dot(right, x)) < 1e-6) profile = { kind: 'rect', w: 2 * Math.abs(c0.x), d: 2 * Math.abs(c0.y) };
        else profile = { kind: 'poly', outer: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
      }
      const revolve: Solid = { kind: 'revolve', profile, frame, axisO: { x: R, y: 0 }, axisDir: { x: dot(k, x), y: dot(k, y) }, angle: defl };
      // A viewer that chords the bend in 11 (web-ifc) tilts the end sections by half a chord:
      // small sections keep the light revolved solid, larger ones get exact end faces
      const half = profile.kind === 'circle' ? profile.r : profile.kind === 'rect' ? profile.w / 2
        : Math.max(...(profile.kind === 'poly' ? profile.outer.map(p => Math.abs(p.x)) : [0]));
      return [half * Math.tan(defl / 22) <= REVOLVE_TILT_MAX ? revolve : revolvedBrep(profile, frame, revolve.axisO, revolve.axisDir, defl)];
    }
    case 'reducer':
    case 'transition': {
      const [a, b] = info.legs;
      if (!a || !b) return null;
      const pa = add(c, scale(dirOf(a), a.trim)), pb = add(c, scale(dirOf(b), b.trim));
      const loft = loftSolid(pa, pb, a.sec, b.sec, hint(a) ?? hint(b));
      return loft ? [loft] : null;
    }
    case 'tap': {
      const br = info.legs.find((_, i) => !info.main || (i !== info.main[0] && i !== info.main[1]));
      if (br) out.push(straight(br, br.trim - 0.01, br.trim + 0.05, 1.08));
      break;
    }
    case 'cap': {
      const l = info.legs[0];
      if (l) out.push(straight(l, -0.02, 0, 1.04));
      break;
    }
    case 'tee':
    case 'cross':
    case 'wye':
    case 'manifold':
      for (const l of info.legs) {
        if (l.trim <= 1e-4) continue;
        out.push(straight(l, 0, l.trim));
        if (info.table === 'duct') out.push(straight(l, l.trim - 0.03, l.trim, 1.06));
      }
      break;
    default:
      return [];
  }
  return out.filter((x): x is Solid => !!x);
}

/**
 * Lightweight IFC body of an inline accessory (valve, damper, meter): the run
 * section (a little oversize) extruded over the accessory length — the 3D
 * view's valve cones / damper blade shaft are faceted detail an IFC consumer
 * doesn't need (hundreds of them in an imported model).
 */
export function accessoryIfcSolids(look: AccessoryLook, levelY: number): Solid[] {
  const d = normalize(v3(look.dir3[0], look.dir3[1], look.dir3[2]));
  if (length(d) < 0.5 || !(look.length > 0)) return [];
  const centre = v3(look.at.x, look.at.y, levelY + look.z);
  const k = look.kind.includes('damper') ? 1.08 : 1.2;
  const profile: Profile = look.round ? { kind: 'circle', r: (look.width * k) / 2 } : { kind: 'rect', w: look.width * k, d: look.height * k };
  return [{ kind: 'extrude', profile, frame: legFrame(add(centre, scale(d, -look.length / 2)), d), depth: look.length }];
}

/**
 * Reducer / transition from section `sa` at `a` to `sb` at `b` as a closed
 * brep of quads: a rectangle has 4 sides, a round section (or a rect ↔ round
 * transition) 16 — not the 3D view's triangulated 24-32 point rings.
 */
function loftSolid(a: V3, b: V3, sa: FittingLeg['sec'], sb: FittingLeg['sec'], hint?: M3): Solid | null {
  const f = sub(b, a);
  if (length(f) < 1e-4) return null;
  const fr = legFrame(a, normalize(f), hint);
  const right = fr.x, up = cross(fr.z, fr.x);
  const N = sa.shape === 'rect' && sb.shape === 'rect' ? 4 : 16;
  const ring = (o: V3, sec: FittingLeg['sec']): V3[] => {
    const hw = Math.max(sec.w, 0.005) / 2, hh = Math.max(sec.shape === 'round' ? sec.w : sec.h, 0.005) / 2;
    const out: V3[] = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2 + (N === 4 ? Math.PI / 4 : 0);
      const cs = Math.cos(t), sn = Math.sin(t);
      // rect: the corner (or edge point) at this angle; round: the circle
      const k = sec.shape === 'round' ? hw : Math.min(hw / Math.max(Math.abs(cs), 1e-9), hh / Math.max(Math.abs(sn), 1e-9));
      const [x, y] = N === 4 && sec.shape === 'rect' ? [Math.sign(cs) * hw, Math.sign(sn) * hh] : [cs * k, sn * k];
      out.push(add(o, add(scale(right, x), scale(up, y))));
    }
    return out;
  };
  const ra = ring(a, sa), rb = ring(b, sb);
  const faces: V3[][] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    faces.push([ra[i], ra[j], rb[j], rb[i]]);
  }
  faces.push([...ra].reverse(), rb);
  return { kind: 'brep', faces };
}

/**
 * An elbow body: the section revolved by `angle` about the line through `axisO`
 * along `axisDir` (both in the frame's XY plane), as a faceted solid. Viewers
 * tessellate an IfcRevolvedAreaSolid their own way (web-ifc tilts its end
 * sections by half a step: a 600 duct elbow stuck out 2 cm past its end faces);
 * here the end faces are exact and the bend is chorded every 7.5° (rect) /
 * 15° (round). Faces swept by a section edge square to the axis are one plane
 * each (a rect elbow has 4 + 2 × segments faces).
 */
/** Largest end-section tilt error (m) an elbow may get from a coarse viewer before it is exported faceted. */
const REVOLVE_TILT_MAX = 0.001;

export function revolvedBrep(profile: Profile, frame: Frame, axisO: V2, axisDir: V2, angle: number): Solid {
  const fy = cross(frame.z, frame.x);
  const at = (u: number, v: number) => add(frame.o, add(scale(frame.x, u), scale(fy, v)));
  const cx = 'cx' in profile ? profile.cx ?? 0 : 0, cy = 'cy' in profile ? profile.cy ?? 0 : 0;
  let pts: V2[];
  if (profile.kind === 'rect') {
    const hw = profile.w / 2, hd = profile.d / 2;
    pts = [{ x: cx - hw, y: cy - hd }, { x: cx + hw, y: cy - hd }, { x: cx + hw, y: cy + hd }, { x: cx - hw, y: cy + hd }];
  } else if (profile.kind === 'circle') {
    const r = profile.r;
    pts = Array.from({ length: 12 }, (_, i) => ({ x: cx + r * Math.cos((i / 12) * Math.PI * 2), y: cy + r * Math.sin((i / 12) * Math.PI * 2) }));
  } else if (profile.kind === 'poly') {
    pts = profile.outer.slice();
    let a2 = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p.x * q.y - q.x * p.y; }
    if (a2 < 0) pts.reverse();
  } else {
    throw new Error(`revolvedBrep: no ${profile.kind} profile`);
  }
  const A = at(axisO.x, axisO.y);
  const k = normalize(add(scale(frame.x, axisDir.x), scale(fy, axisDir.y)));
  const segs = Math.max(2, Math.ceil(angle / ((profile.kind === 'circle' ? 15 : 7.5) * Math.PI / 180)));
  // Right-handed rotation of p about the axis (Rodrigues)
  const rot = (p: V3, t: number): V3 => {
    const r = sub(p, A), c = Math.cos(t), sn = Math.sin(t);
    return add(A, add(add(scale(r, c), scale(cross(k, r), sn)), scale(k, dot(k, r) * (1 - c))));
  };
  const base = pts.map(p => at(p.x, p.y));
  const rings = Array.from({ length: segs + 1 }, (_, j) => base.map(p => rot(p, (angle * j) / segs)));
  const n = base.length;
  const faces: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    if (Math.abs(dot(sub(base[i], A), k) - dot(sub(base[i2], A), k)) < 1e-9) {
      // The edge sweeps a plane square to the axis: one face (out along edge i2, back along edge i)
      faces.push([rings[0][i], ...rings.map(r => r[i2]), ...rings.slice(1).reverse().map(r => r[i])]);
    } else {
      for (let j = 0; j < segs; j++) faces.push([rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i]]);
    }
  }
  faces.push([...rings[0]].reverse(), rings[segs]);
  return { kind: 'brep', faces };
}

/** Passive fitting body (elbow / tee / reducer …) or inline accessory body (valve / damper) of a mep_node. */
export function mepNodeSolids(f: MepNodeFacts | null): Solid[] {
  if (!f) return [];
  if (f.fitting) {
    const s = threeSolid(fittingGeometry(f.fitting, f.levelY, f.riserRight));
    return s ? [s] : [];
  }
  if (f.accessory) {
    const look = f.accessory;
    const m = new Matrix4().makeTranslation(look.at.x, f.levelY + look.z, -look.at.y).multiply(accessoryBasis(look));
    const out: Solid[] = [];
    for (const g of accessoryGeometry(look)) {
      g.applyMatrix4(m);
      const s = threeSolid(g);
      if (s) out.push(s);
    }
    return out;
  }
  return [];
}
