/**
 * Small 3D toolkit for MEP fitting bodies: model ↔ three.js frames, section
 * rings (rect / round) and sweeps along straight or arc paths, plus a loft
 * between two different sections (reducers, transitions).
 *
 * Model frame: x east, y north, z up (level-relative). three.js world:
 * (x, z + baseY, -y). Section frames follow `uprightAxisQuaternion` so a
 * fitting body lines up with the duct extrusions it joins: local +X (size_x)
 * = up × forward, local +Y (size_y) = forward × right.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/** Model point (level-relative z) → three.js world position. */
export const toWorld = (p: V3, baseY: number): V3 => [p[0], p[2] + baseY, -p[1]];
/** Model direction → three.js world direction. */
export const dirToWorld = (d: V3): V3 => [d[0], d[2], -d[1]];

export interface Frame { right: V3; up: V3 }

/** Section frame for a member running along world direction `f`. `rightHint`
 *  pins the width axis of vertical members (risers) to the run they join. */
export function sectionFrame(f: V3, rightHint?: V3): Frame {
  const fw = norm(f);
  let right: V3;
  if (rightHint && Math.abs(dot(norm(rightHint), fw)) < 0.9) {
    right = norm(sub(rightHint, mul(fw, dot(rightHint, fw))));
  } else {
    let up: V3 = [0, 1, 0];
    if (Math.abs(dot(fw, up)) > 0.999) up = [1, 0, 0];
    right = norm(cross(up, fw));
  }
  return { right, up: norm(cross(fw, right)) };
}

export interface Section { shape: 'round' | 'rect'; w: number; h: number }

/** Section outline in local (x = right, y = up) coords. Rect corners are
 *  doubled so normals stay flat; round uses `n` shared points. */
export function sectionRing(s: Section, n = 24): [number, number][] {
  if (s.shape === 'round') {
    const r = Math.max(s.w, 0.005) / 2;
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
  }
  const hw = Math.max(s.w, 0.005) / 2, hh = Math.max(s.h, 0.005) / 2;
  const c: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const out: [number, number][] = [];
  for (let i = 0; i < 4; i++) { out.push(c[i]); out.push(c[(i + 1) % 4]); }
  return out;
}

/** Section sampled at `n` angles (for lofting rect ↔ round). */
export function sectionRingByAngle(s: Section, n = 32): [number, number][] {
  const out: [number, number][] = [];
  const hw = Math.max(s.w, 0.005) / 2, hh = Math.max(s.shape === 'round' ? s.w : s.h, 0.005) / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const c = Math.cos(a), sn = Math.sin(a);
    if (s.shape === 'round') { out.push([c * hw, sn * hw]); continue; }
    const k = Math.min(hw / Math.max(Math.abs(c), 1e-9), hh / Math.max(Math.abs(sn), 1e-9));
    out.push([c * k, sn * k]);
  }
  return out;
}

interface RingAt { center: V3; frame: Frame; ring: [number, number][] }

/** Skin consecutive rings (same point count) into a closed tube, with end caps. */
export function skinRings(rings: RingAt[], caps = true): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = rings[0].ring.length;
  for (const r of rings) {
    for (const [x, y] of r.ring) {
      const p = add(r.center, add(mul(r.frame.right, x), mul(r.frame.up, y)));
      pos.push(p[0], p[1], p[2]);
    }
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < n; i++) {
      const a = k * n + i, b = k * n + ((i + 1) % n), c = (k + 1) * n + i, d = (k + 1) * n + ((i + 1) % n);
      idx.push(a, b, d, a, d, c);
    }
  }
  if (caps) {
    for (const [k, flip] of [[0, true], [rings.length - 1, false]] as const) {
      const base = pos.length / 3;
      const c = rings[k].center;
      pos.push(c[0], c[1], c[2]);
      for (let i = 0; i < n; i++) {
        const a = k * n + i, b = k * n + ((i + 1) % n);
        if (flip) idx.push(base, b, a); else idx.push(base, a, b);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Straight body from `a` to `b` (world) with section `s`. */
export function straightBody(a: V3, b: V3, s: Section, rightHint?: V3): BufferGeometry | null {
  const f = sub(b, a);
  if (len(f) < 1e-4) return null;
  const frame = sectionFrame(f, rightHint);
  const ring = sectionRing(s);
  return skinRings([{ center: a, frame, ring }, { center: b, frame, ring }]);
}

/** Loft between two sections (reducer / transition), `a` → `b` (world). */
export function loftBody(a: V3, b: V3, sa: Section, sb: Section, rightHint?: V3): BufferGeometry | null {
  const f = sub(b, a);
  if (len(f) < 1e-4) return null;
  const frame = sectionFrame(f, rightHint);
  const same = sa.shape === sb.shape;
  const ra = same ? sectionRing(sa) : sectionRingByAngle(sa);
  const rb = same ? sectionRing(sb) : sectionRingByAngle(sb);
  return skinRings([{ center: a, frame, ring: ra }, { center: b, frame, ring: rb }]);
}

/**
 * Bend from tangent point `ta` (leaving along -da) to `tb`, around `corner`,
 * both legs pointing outward from the corner (`da`, `db`, world, unit).
 * The section keeps its orientation relative to the bend (parallel
 * transport about the bend axis), starting from leg A's frame.
 */
export function elbowBody(corner: V3, da: V3, db: V3, radius: number, s: Section, rightHintA?: V3, steps = 12): BufferGeometry | null {
  const cosT = Math.max(-1, Math.min(1, dot(da, db)));
  const theta = Math.acos(cosT);          // angle between the legs
  const defl = Math.PI - theta;           // how much the flow turns
  if (defl < 1e-3 || radius <= 1e-4) return null;
  const t = radius * Math.tan(defl / 2);
  const ta = add(corner, mul(da, t));
  const bis = norm(add(da, db));
  const center = add(corner, mul(bis, radius / Math.cos(defl / 2)));
  const e1 = norm(sub(ta, center));
  const axis = norm(cross(da, db)); // bend axis
  // Flow direction at A is -da (towards the corner).
  const frameA = sectionFrame(mul(da, -1), rightHintA);
  const ring = sectionRing(s);
  const rings: RingAt[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * defl;
    const rot = (v: V3) => rotateAbout(v, axis, sign(axis, e1, da) * phi);
    const p = add(center, mul(rot(e1), radius));
    rings.push({ center: p, frame: { right: rot(frameA.right), up: rot(frameA.up) }, ring });
  }
  return skinRings(rings, false);
}

/** Rotation direction so that rotating e1 moves towards leg B. */
function sign(axis: V3, e1: V3, da: V3): number {
  // Tangent at A along the flow is -da; rotating e1 about +axis gives axis × e1.
  return dot(cross(axis, e1), mul(da, -1)) >= 0 ? 1 : -1;
}

/** Rodrigues rotation of `v` about unit `k` by `a` radians. */
export function rotateAbout(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/** Merge several geometries into one (positions + indices). */
export function mergeGeometries(parts: (BufferGeometry | null)[]): BufferGeometry | null {
  const list = parts.filter((g): g is BufferGeometry => !!g);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const g of list) {
    const base = pos.length / 3;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}
