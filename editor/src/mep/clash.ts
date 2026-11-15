/**
 * MEP clash detection — pure core, no I/O.
 *
 * Two identical copies: bimdown-spec `cli/src/mep/clash.ts` (`bimdown clash`)
 * and bimdown-editor `editor/src/mep/clash.ts` (MEP panel, Clash tab). Edit
 * one, copy it over the other.
 *
 * Input is flat and unit-agnostic (one length unit, one z frame): MEP curves
 * (duct / pipe / conduit / cable_tray) as straight 3D centre lines with a
 * rect / round section, MEP devices as boxes, and the building as obstacles:
 * framing members (beams, braces, columns, piles, strip footings), boxes (pad
 * footings), straight walls with their openings, and slabs (plan polygon with
 * holes between two heights).
 *
 * Solids are oriented boxes and flat-ended cylinders, tested by separating
 * axes with exact support functions (face normals, edge cross products, and
 * the direction between the closest points of a cylinder's axis and the
 * other core); the smallest overlap over the axes is the penetration depth.
 * Slabs are a z band plus a plan polygon, clipped along the curve. Broad
 * phase: sort-and-sweep over x, then AABB overlap.
 *
 * Kinds and severity:
 * - `hard`, high: MEP vs structure (beam, brace, column, structural wall,
 *   foundation).
 * - `hard`, medium: MEP vs MEP that is not physically connected (pairs that
 *   share a fitting / port / device through `from` / `to`, segments of one
 *   system meeting at an end, and an unreferenced curve end tapping into a
 *   body or sitting on a device are connected).
 * - `penetration`, low: MEP through a slab / roof / non-structural wall that
 *   no opening, slab hole or shaft covers (needs a sleeve or an opening).
 * - `clearance`, low: MEP vs MEP / structure closer than `clearance`.
 *
 * `tolerance` (default 5 cm) is the overlap modelling slack: hard clashes and
 * penetrations no deeper than it are not clashes; with `minor` they are
 * returned flagged `minor` (within tolerance). `clearance` is separate: the
 * gap required between elements that don't overlap at all.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface ClashCurveIn {
  id: string;
  /** Id scope (level directory). Ids are unique per scope. */
  scope?: string;
  table: string;
  a: Vec3;
  b: Vec3;
  shape: 'rect' | 'round';
  /** Section width (round: diameter) and height, insulation excluded. */
  w: number;
  h: number;
  insulation?: number;
  system: string;
  /** Port refs (`host` or `host:port`). */
  from?: string;
  to?: string;
}

export interface ClashHostIn {
  id: string;
  scope?: string;
  /** equipment / terminal / mep_node. */
  table: string;
  /** Box centre and half sizes (x / y in the device frame, z up). */
  center: Vec3;
  half: Vec3;
  /** Plan rotation, degrees CCW. */
  rotation?: number;
  system: string;
  /** Passive fitting (elbow, tee, …): a joint curves refer to, not a solid. */
  fitting?: boolean;
}

export interface ClashMemberIn {
  id: string;
  scope?: string;
  table: string;
  a: Vec3;
  b: Vec3;
  shape: 'rect' | 'round';
  /** Section width across (round: diameter) and depth. */
  w: number;
  h: number;
  /** The line runs along the section's top edge (beams, braces, footings); else its centre (columns). */
  top?: boolean;
  /** Plan rotation (degrees) of a vertical member's section. */
  rotation?: number;
}

export interface ClashBoxIn {
  id: string;
  scope?: string;
  table: string;
  center: Vec3;
  half: Vec3;
  rotation?: number;
}

export interface WallOpeningIn {
  /** Span along the wall from `a`, and the bottom / top height. */
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

export interface ClashWallIn {
  id: string;
  scope?: string;
  table: string;
  a: Vec2;
  b: Vec2;
  thickness: number;
  z0: number;
  z1: number;
  /** Structural wall: hard clash. Else a penetration openings can cover. */
  structural: boolean;
  openings?: WallOpeningIn[];
}

export interface ClashSlabIn {
  id: string;
  scope?: string;
  table: string;
  outer: Vec2[];
  /** Inner rings, slab openings and shafts through it. */
  holes?: Vec2[][];
  z0: number;
  z1: number;
  /** Foundation raft / pile cap: hard clash. Else a penetration. */
  structural?: boolean;
}

export interface ClashModelIn {
  curves: ClashCurveIn[];
  hosts: ClashHostIn[];
  members?: ClashMemberIn[];
  boxes?: ClashBoxIn[];
  walls?: ClashWallIn[];
  slabs?: ClashSlabIn[];
}

export interface ClashOptions {
  /** Overlaps no deeper than this are within tolerance, not clashes; model units. Default 0.05 (5 cm in metres); 0 = every overlap. */
  tolerance?: number;
  /** MEP vs MEP / structure closer than this (without overlapping) is a clearance clash. 0 = off (default). */
  clearance?: number;
  /** Also return the overlaps within tolerance, flagged `minor`. */
  minor?: boolean;
  /** Only MEP vs MEP. */
  mepOnly?: boolean;
}

export type ClashSeverity = 'high' | 'medium' | 'low';
export type ClashKind = 'hard' | 'penetration' | 'clearance';

export interface Clash {
  /** The MEP element (the first MEP one for MEP vs MEP). */
  a: string;
  aTable: string;
  aScope?: string;
  b: string;
  bTable: string;
  bScope?: string;
  severity: ClashSeverity;
  kind: ClashKind;
  /** Centre of the overlap (clearance: across the gap). */
  at: Vec3;
  /** Penetration depth (clearance: the gap). */
  depth: number;
  systems: string[];
  /** Overlap within tolerance (only with `minor`); not counted as a clash. */
  minor?: true;
}

// ─── Vectors ──────────────────────────────────────────────

const EPS = 1e-9;
/** Overlap below this is touching, not overlapping (any length unit). */
const CONTACT = 1e-6;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const Z: Vec3 = [0, 0, 1];

// ─── Solids ───────────────────────────────────────────────

/** Oriented box (half sizes `e` along `u`), or a flat-ended cylinder along
 *  `u[0]` (half length e[0], radius e[1] = e[2]). */
interface Solid { c: Vec3; u: [Vec3, Vec3, Vec3]; e: Vec3; round: boolean }

/** Frame of a member running along unit `f`: `right` horizontal across it,
 *  `up` = f × right (upwards). Vertical members turn `right` by `rotation`. */
function lineFrame(f: Vec3, rotationDeg = 0): [Vec3, Vec3, Vec3] {
  let right: Vec3;
  const h = Math.hypot(f[0], f[1]);
  if (h < 1e-6) {
    const t = (rotationDeg * Math.PI) / 180;
    right = [Math.cos(t), Math.sin(t), 0];
  } else {
    right = [-f[1] / h, f[0] / h, 0];
  }
  return [f, right, cross(f, right)];
}

function lineSolid(a: Vec3, b: Vec3, shape: string, w: number, h: number, top = false, rotation = 0): Solid | null {
  const d = sub(b, a);
  const L = len(d);
  if (!(L > EPS) || !(w > 0)) return null;
  const u = lineFrame(mul(d, 1 / L), rotation);
  const round = shape === 'round';
  const hw = w / 2;
  const hh = round ? hw : (h > 0 ? h : w) / 2;
  let c = lerp(a, b, 0.5);
  if (top) c = sub(c, mul(u[2], hh));
  return { c, u, e: [L / 2, hw, hh], round };
}

function boxSolid(center: Vec3, half: Vec3, rotationDeg = 0): Solid {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return { c: center, u: [[c, s, 0], [-s, c, 0], Z], e: [Math.abs(half[0]), Math.abs(half[1]), Math.abs(half[2])], round: false };
}

/** Half extent of `s` along unit `n`. */
function support(s: Solid, n: Vec3): number {
  if (s.round) {
    const k = dot(n, s.u[0]);
    return s.e[0] * Math.abs(k) + s.e[1] * Math.sqrt(Math.max(0, 1 - k * k));
  }
  return s.e[0] * Math.abs(dot(n, s.u[0])) + s.e[1] * Math.abs(dot(n, s.u[1])) + s.e[2] * Math.abs(dot(n, s.u[2]));
}

/** Half extent of a member's cross-section along `n` (the axial part left out). */
function sectionSupport(s: Solid, n: Vec3): number {
  if (s.round) {
    const k = dot(n, s.u[0]);
    return s.e[1] * Math.sqrt(Math.max(0, 1 - k * k));
  }
  return s.e[1] * Math.abs(dot(n, s.u[1])) + s.e[2] * Math.abs(dot(n, s.u[2]));
}

/** Closest point of `s` to `p` (cylinders exactly, boxes by clamping). */
function clampInto(s: Solid, p: Vec3): Vec3 {
  const d = sub(p, s.c);
  if (s.round) {
    const ax = dot(d, s.u[0]);
    const radial = sub(d, mul(s.u[0], ax));
    const r = len(radial);
    const rr = r > s.e[1] ? mul(radial, s.e[1] / r) : radial;
    return add(add(s.c, mul(s.u[0], clamp(ax, -s.e[0], s.e[0]))), rr);
  }
  let out = s.c;
  for (let k = 0; k < 3; k++) out = add(out, mul(s.u[k], clamp(dot(d, s.u[k]), -s.e[k], s.e[k])));
  return out;
}

function segSegClosest(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) { /* both points */ }
  else if (a <= EPS) t = clamp(f / e, 0, 1);
  else {
    const c = dot(d1, r);
    if (e <= EPS) s = clamp(-c / a, 0, 1);
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return [add(p1, mul(d1, s)), add(p2, mul(d2, t))];
}

const axisEnds = (s: Solid): [Vec3, Vec3] => [sub(s.c, mul(s.u[0], s.e[0])), add(s.c, mul(s.u[0], s.e[0]))];

/** Closest points between a cylinder's axis and the other core (axis or box). */
function coreClosest(cyl: Solid, other: Solid): [Vec3, Vec3] {
  const [p, q] = axisEnds(cyl);
  if (other.round) {
    const [r, s] = axisEnds(other);
    return segSegClosest(p, q, r, s);
  }
  // Distance from the axis to a box is convex along the axis: ternary search.
  const box: Solid = { ...other, round: false };
  const dist = (t: number) => { const x = lerp(p, q, t); return len(sub(x, clampInto(box, x))); };
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist(m1) <= dist(m2)) hi = m2; else lo = m1;
  }
  const x = lerp(p, q, (lo + hi) / 2);
  return [x, clampInto(box, x)];
}

/** Smallest overlap of A and B over the candidate separating axes (< 0: apart, -value ≈ the gap). */
function satDepth(A: Solid, B: Solid): number {
  const axes: Vec3[] = [...A.u, ...B.u];
  for (const ua of A.u) {
    for (const ub of B.u) {
      const c = cross(ua, ub);
      const l = len(c);
      if (l > 1e-6) axes.push(mul(c, 1 / l));
    }
  }
  if (A.round || B.round) {
    const [p, q] = A.round ? coreClosest(A, B) : coreClosest(B, A);
    const d = sub(q, p);
    const l = len(d);
    if (l > 1e-9) axes.push(mul(d, 1 / l));
  }
  const d = sub(B.c, A.c);
  let best = Infinity;
  for (const n of axes) {
    const o = support(A, n) + support(B, n) - Math.abs(dot(d, n));
    if (o < best) best = o;
  }
  return best;
}

/** Parameter range of the axis a→b where the member's section overlaps `B` (B taken as a box). */
function clipAxis(a: Vec3, b: Vec3, member: Solid, B: Solid, grow = 0): [number, number] | null {
  let t0 = 0, t1 = 1;
  const d = sub(b, a);
  for (let k = 0; k < 3; k++) {
    const n = B.u[k];
    const lim = B.e[k] + sectionSupport(member, n) + grow;
    const p0 = dot(sub(a, B.c), n);
    const dp = dot(d, n);
    if (Math.abs(dp) < EPS) {
      if (Math.abs(p0) > lim) return null;
      continue;
    }
    let ta = (-lim - p0) / dp, tb = (lim - p0) / dp;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// ─── Plan polygons ────────────────────────────────────────

function inRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringDistance(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > EPS ? clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - dx * t, p[1] - ay - dy * t));
  }
  return best;
}

/** Parameters along p→q where it crosses the ring's edges. */
function ringCrossings(p: Vec2, q: Vec2, ring: readonly Vec2[], out: number[]): void {
  const rx = q[0] - p[0], ry = q[1] - p[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const sx = bx - ax, sy = by - ay;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < EPS) continue;
    const qx = ax - p[0], qy = ay - p[1];
    const t = (qx * sy - qy * sx) / den;
    const v = (qx * ry - qy * rx) / den;
    if (t > 0 && t < 1 && v >= 0 && v <= 1) out.push(t);
  }
}

type PlanPart = { s0: number; s1: number; hole: number };  // hole: -2 outside, -1 solid, ≥0 hole index

/** Split p→q into runs outside the slab, over solid slab, or over a hole. */
function planParts(p: Vec2, q: Vec2, outer: readonly Vec2[], holes: readonly Vec2[][]): PlanPart[] {
  const classify = (m: Vec2) => {
    if (!inRing(m, outer)) return -2;
    for (let i = 0; i < holes.length; i++) if (holes[i].length >= 3 && inRing(m, holes[i])) return i;
    return -1;
  };
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) return [{ s0: 0, s1: 1, hole: classify(p) }];
  const ts = [0, 1];
  ringCrossings(p, q, outer, ts);
  for (const h of holes) ringCrossings(p, q, h, ts);
  ts.sort((x, y) => x - y);
  const parts: PlanPart[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const s0 = ts[i], s1 = ts[i + 1];
    if (s1 - s0 < 1e-9) continue;
    const s = (s0 + s1) / 2;
    const hole = classify([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s]);
    const last = parts[parts.length - 1];
    if (last && last.hole === hole) last.s1 = s1; else parts.push({ s0, s1, hole });
  }
  return parts;
}

// ─── Model ────────────────────────────────────────────────

type Cat = 'curve' | 'host' | 'hard' | 'soft';

interface Item {
  cat: Cat;
  id: string;
  table: string;
  scope?: string;
  key: string;
  system: string;
  solid?: Solid;
  slab?: { outer: Vec2[]; holes: Vec2[][]; z0: number; z1: number };
  wall?: { a: Vec2; dir: Vec2; openings: WallOpeningIn[] };
  /** Curves: centre-line ends, and which of them have no `from` / `to` ref. */
  ends?: [Vec3, Vec3];
  open?: [boolean, boolean];
  /** Full section size (insulated). */
  size: number;
  /** Curves: joint keys of `from` / `to`; hosts: their own key. */
  joints: string[];
  /** Checked against walls and slabs (curves, equipment). */
  penetrates: boolean;
  /** AABB: min x, y, z, max x, y, z. */
  box: [number, number, number, number, number, number];
}

const keyOf = (scope: string | undefined, id: string) => `${scope ?? ''}/${id}`;
const isMep = (it: Item) => it.cat === 'curve' || it.cat === 'host';

function solidBox(s: Solid): Item['box'] {
  const ex = support(s, [1, 0, 0]), ey = support(s, [0, 1, 0]), ez = support(s, Z);
  return [s.c[0] - ex, s.c[1] - ey, s.c[2] - ez, s.c[0] + ex, s.c[1] + ey, s.c[2] + ez];
}

function splitSystems(s: string): string[] {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function compatible(a: string, b: string): boolean {
  const A = splitSystems(a), B = splitSystems(b);
  return A.length === 0 || B.length === 0 || A.some(x => B.includes(x));
}

function pointSegDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 > EPS ? clamp(dot(sub(p, a), d) / l2, 0, 1) : 0;
  return len(sub(p, add(a, mul(d, t))));
}

function insideGrown(s: Solid, p: Vec3, grow: number): boolean {
  return len(sub(p, clampInto(s, p))) <= grow + 1e-6;
}

/** Physically connected MEP pairs, which never clash. */
function connected(A: Item, B: Item): boolean {
  if (A.cat === 'curve' && B.cat === 'curve') {
    if (A.joints.some(j => B.joints.includes(j))) return true;
    if (!compatible(A.system, B.system)) return false;
    const [a0, a1] = A.ends!, [b0, b1] = B.ends!;
    // Segments of one run meeting at an end (also across a short offset).
    const reach = Math.max(A.size, B.size);
    for (const p of [a0, a1]) for (const q of [b0, b1]) if (len(sub(p, q)) <= reach) return true;
    // A branch whose open end sits on (taps into) the other's body.
    const tap = (A.size + B.size) / 2 + 1e-6;
    const taps = (X: Item, Y: Item) => X.ends!.some((p, k) => X.open![k] && pointSegDistance(p, Y.ends![0], Y.ends![1]) <= tap);
    return taps(A, B) || taps(B, A);
  }
  const curve = A.cat === 'curve' ? A : B.cat === 'curve' ? B : null;
  const host = A.cat === 'host' ? A : B.cat === 'host' ? B : null;
  if (!curve || !host) return false;
  if (curve.joints.includes(host.key)) return true;
  if (!compatible(curve.system, host.system)) return false;
  return curve.ends!.some((p, k) => curve.open![k] && insideGrown(host.solid!, p, curve.size / 2));
}

function overlapPoint(A: Item, B: Item, grow: number): Vec3 {
  let p: Vec3 | null = null;
  const member = A.ends ? A : B.ends ? B : null;
  const other = member === A ? B : A;
  if (member && member.solid && other.solid) {
    const iv = clipAxis(member.ends![0], member.ends![1], member.solid, other.solid, grow);
    if (iv) p = lerp(member.ends![0], member.ends![1], (iv[0] + iv[1]) / 2);
  }
  if (!p) {
    const a = A.box, b = B.box;
    p = [0, 1, 2].map(k => (Math.max(a[k], b[k]) + Math.min(a[k + 3], b[k + 3])) / 2) as Vec3;
  }
  const q = clampInto(B.solid!, p);
  const r = clampInto(A.solid!, q);
  return lerp(q, r, 0.5);
}

/** A curve / equipment item against a slab: depth in z and a point over solid slab, or null. */
function slabHit(it: Item, slab: Item, floor: number): { depth: number; at: Vec3 } | null {
  const sl = slab.slab!;
  const s = it.solid!;
  const zc = (sl.z0 + sl.z1) / 2, hz = (sl.z1 - sl.z0) / 2;
  if (it.ends) {
    const [a, b] = it.ends;
    const sz = sectionSupport(s, Z);
    const lim = hz + sz;
    let t0 = 0, t1 = 1;
    const dz = b[2] - a[2], p0 = a[2] - zc;
    if (Math.abs(dz) < EPS) {
      if (Math.abs(p0) > lim) return null;
    } else {
      let ta = (-lim - p0) / dz, tb = (lim - p0) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(0, ta);
      t1 = Math.min(1, tb);
      if (t0 > t1) return null;
    }
    const za = a[2] + dz * t0, zb = a[2] + dz * t1;
    const depth = Math.min(Math.max(za, zb) + sz, sl.z1) - Math.max(Math.min(za, zb) - sz, sl.z0);
    if (depth <= floor) return null;
    const pa = lerp(a, b, t0), pb = lerp(a, b, t1);
    const p: Vec2 = [pa[0], pa[1]], q: Vec2 = [pb[0], pb[1]];
    const planR = Math.max(sectionSupport(s, [1, 0, 0]), sectionSupport(s, [0, 1, 0]));
    let best: PlanPart | null = null, bestDepth = 0;
    for (const part of planParts(p, q, sl.outer, sl.holes)) {
      let d = part.hole === -1 ? depth : 0;
      if (part.hole >= 0) {
        // Over a hole: still a clash when the opening is too small for the section, as deep as it bites into the edge.
        const m = (part.s0 + part.s1) / 2;
        d = Math.min(depth, planR - ringDistance([p[0] + (q[0] - p[0]) * m, p[1] + (q[1] - p[1]) * m], sl.holes[part.hole]));
      }
      if (d > floor && (!best || d > bestDepth || (d === bestDepth && part.s1 - part.s0 > best.s1 - best.s0))) { best = part; bestDepth = d; }
    }
    if (!best) return null;
    const at = lerp(pa, pb, (best.s0 + best.s1) / 2);
    at[2] = clamp(at[2], sl.z0, sl.z1);
    return { depth: bestDepth, at };
  }
  const depth = Math.min(it.box[5], sl.z1) - Math.max(it.box[2], sl.z0);
  if (depth <= floor) return null;
  const pts: Vec3[] = [s.c];
  for (const i of [-1, 1]) for (const j of [-1, 1]) pts.push(add(add(s.c, mul(s.u[0], s.e[0] * i)), mul(s.u[1], s.e[1] * j)));
  for (const pt of pts) {
    const xy: Vec2 = [pt[0], pt[1]];
    if (inRing(xy, sl.outer) && !sl.holes.some(h => h.length >= 3 && inRing(xy, h))) {
      return { depth, at: [pt[0], pt[1], clamp(s.c[2], sl.z0, sl.z1)] };
    }
  }
  return null;
}

/** Does a wall opening take the curve through? */
function wallCovered(curve: Item, wall: Item, slack: number): boolean {
  const w = wall.wall!;
  if (w.openings.length === 0 || !curve.ends) return false;
  const iv = clipAxis(curve.ends[0], curve.ends[1], curve.solid!, wall.solid!);
  if (!iv) return false;
  const p = lerp(curve.ends[0], curve.ends[1], (iv[0] + iv[1]) / 2);
  const u = (p[0] - w.a[0]) * w.dir[0] + (p[1] - w.a[1]) * w.dir[1];
  const su = sectionSupport(curve.solid!, [w.dir[0], w.dir[1], 0]);
  const sz = sectionSupport(curve.solid!, Z);
  return w.openings.some(o => u - su >= o.u0 - slack && u + su <= o.u1 + slack && p[2] - sz >= o.z0 - slack && p[2] + sz <= o.z1 + slack);
}

function buildItems(m: ClashModelIn): Item[] {
  const items: Item[] = [];
  // Host ids by scope, to resolve `from` / `to` like the connectivity check.
  const hostScopes = new Map<string, string[]>();
  for (const h of m.hosts) {
    const list = hostScopes.get(h.id);
    if (list) list.push(h.scope ?? ''); else hostScopes.set(h.id, [h.scope ?? '']);
  }
  const joint = (ref: string | undefined, scope: string | undefined): string | null => {
    const host = (ref ?? '').split(':')[0].trim();
    if (!host) return null;
    const scopes = hostScopes.get(host);
    const own = scope ?? '';
    if (!scopes || scopes.includes(own)) return keyOf(scope, host);
    return keyOf(scopes.includes('global') ? 'global' : scopes[0], host);
  };

  for (const c of m.curves) {
    const ins = Math.max(0, c.insulation ?? 0);
    const w = c.w + 2 * ins;
    const h = (c.shape === 'round' ? c.w : c.h > 0 ? c.h : c.w) + 2 * ins;
    const solid = lineSolid(c.a, c.b, c.shape, w, h);
    if (!solid) continue;
    const joints = [joint(c.from, c.scope), joint(c.to, c.scope)].filter((j): j is string => !!j);
    items.push({
      cat: 'curve', id: c.id, table: c.table, scope: c.scope, key: keyOf(c.scope, c.id), system: c.system,
      solid, ends: [c.a, c.b], open: [!(c.from ?? '').trim(), !(c.to ?? '').trim()],
      size: Math.max(w, h), joints, penetrates: true, box: solidBox(solid),
    });
  }
  for (const h of m.hosts) {
    if (h.fitting) continue;
    const solid = boxSolid(h.center, h.half, h.rotation);
    if (!(solid.e[0] > 0 && solid.e[1] > 0 && solid.e[2] > 0)) continue;
    const key = keyOf(h.scope, h.id);
    items.push({
      cat: 'host', id: h.id, table: h.table, scope: h.scope, key, system: h.system,
      solid, size: 2 * Math.max(...solid.e), joints: [key], penetrates: h.table === 'equipment', box: solidBox(solid),
    });
  }
  const obstacle = (o: { id: string; table: string; scope?: string }, cat: Cat, solid: Solid, extra: Partial<Item> = {}) => {
    items.push({
      cat, id: o.id, table: o.table, scope: o.scope, key: keyOf(o.scope, o.id), system: '',
      solid, size: 0, joints: [], penetrates: false, box: solidBox(solid), ...extra,
    });
  };
  for (const mb of m.members ?? []) {
    const solid = lineSolid(mb.a, mb.b, mb.shape, mb.w, mb.h, mb.top, mb.rotation);
    if (solid) obstacle(mb, 'hard', solid);
  }
  for (const bx of m.boxes ?? []) {
    const solid = boxSolid(bx.center, bx.half, bx.rotation);
    if (solid.e[0] > 0 && solid.e[1] > 0 && solid.e[2] > 0) obstacle(bx, 'hard', solid);
  }
  for (const w of m.walls ?? []) {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dy);
    if (!(L > EPS) || !(w.thickness > 0) || !(w.z1 > w.z0)) continue;
    const dir: Vec2 = [dx / L, dy / L];
    const solid: Solid = {
      c: [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2, (w.z0 + w.z1) / 2],
      u: [[dir[0], dir[1], 0], [-dir[1], dir[0], 0], Z],
      e: [L / 2, w.thickness / 2, (w.z1 - w.z0) / 2],
      round: false,
    };
    obstacle(w, w.structural ? 'hard' : 'soft', solid, { wall: { a: w.a, dir, openings: w.openings ?? [] } });
  }
  for (const s of m.slabs ?? []) {
    if (s.outer.length < 3 || !(s.z1 > s.z0)) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of s.outer) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    items.push({
      cat: s.structural ? 'hard' : 'soft', id: s.id, table: s.table, scope: s.scope, key: keyOf(s.scope, s.id), system: '',
      slab: { outer: s.outer, holes: s.holes ?? [], z0: s.z0, z1: s.z1 },
      size: 0, joints: [], penetrates: false, box: [minX, minY, s.z0, maxX, maxY, s.z1],
    });
  }
  return items;
}

const SEVERITY_ORDER: Record<ClashSeverity, number> = { high: 0, medium: 1, low: 2 };

/** All clashes in the model, most severe and deepest first. */
export function detectClashes(m: ClashModelIn, opts: ClashOptions = {}): Clash[] {
  const tol = Math.max(0, opts.tolerance ?? 0.05);
  const clr = Math.max(0, opts.clearance ?? 0);
  // Overlaps deeper than `floor` and no deeper than `tol` are minor.
  const floor = CONTACT;
  const items = buildItems(m);
  const found = new Map<string, Clash>();

  const record = (A: Item, B: Item, kind: ClashKind, severity: ClashSeverity, depth: number, at: Vec3) => {
    const minor = kind !== 'clearance' && depth <= tol;
    if (minor && !opts.minor) return;
    const key = `${A.key}|${B.key}`;
    const prev = found.get(key);
    if (prev && prev.depth >= depth) return;
    const systems = [...new Set([...splitSystems(A.system), ...splitSystems(B.system)])];
    found.set(key, {
      a: A.id, aTable: A.table, ...(A.scope !== undefined ? { aScope: A.scope } : {}),
      b: B.id, bTable: B.table, ...(B.scope !== undefined ? { bScope: B.scope } : {}),
      severity, kind, at, depth, systems, ...(minor ? { minor: true as const } : {}),
    });
  };

  const narrow = (A: Item, B: Item) => {
    // A is MEP. B: MEP, hard obstacle or soft (penetration) obstacle.
    // Terminals and accessories sit in walls and floors by design (outlets, drains, fire dampers).
    if (!A.penetrates && (B.wall || B.slab)) return;
    if (B.slab) {
      const hit = slabHit(A, B, floor);
      if (hit) record(A, B, B.cat === 'hard' ? 'hard' : 'penetration', B.cat === 'hard' ? 'high' : 'low', hit.depth, hit.at);
      return;
    }
    if (isMep(B) && connected(A, B)) return;
    const depth = satDepth(A.solid!, B.solid!);
    if (depth > floor) {
      if (B.cat === 'soft') {
        if (A.ends && B.wall && wallCovered(A, B, floor)) return;
        record(A, B, 'penetration', 'low', depth, overlapPoint(A, B, 0));
      } else {
        record(A, B, 'hard', B.cat === 'hard' ? 'high' : 'medium', depth, overlapPoint(A, B, 0));
      }
      return;
    }
    if (clr > 0 && B.cat !== 'soft') {
      const gap = Math.max(0, -depth);
      if (gap < clr) record(A, B, 'clearance', 'low', gap, overlapPoint(A, B, gap));
    }
  };

  // Broad phase: sweep over x, AABBs grown by the clearance.
  const order = items.map((_, i) => i).sort((i, j) => items[i].box[0] - items[j].box[0]);
  let active: number[] = [];
  for (const i of order) {
    const A = items[i];
    const bi = A.box;
    active = active.filter(j => items[j].box[3] + clr >= bi[0]);
    for (const j of active) {
      const B = items[j];
      const mepA = isMep(A), mepB = isMep(B);
      if (!mepA && !mepB) continue;
      if (opts.mepOnly && (!mepA || !mepB)) continue;
      const bj = B.box;
      if (bj[1] > bi[4] + clr || bi[1] > bj[4] + clr || bj[2] > bi[5] + clr || bi[2] > bj[5] + clr) continue;
      let first = A, second = B;
      // MEP first; curves before devices; else input order.
      if (!mepA || (mepB && A.cat === 'host' && B.cat === 'curve') || (mepB && A.cat === B.cat && j < i)) { first = B; second = A; }
      narrow(first, second);
    }
    active.push(i);
  }

  // A run split where it crosses something (two segments meeting inside the
  // obstacle) is one clash: keep the deeper of connected segments' hits on
  // the same obstacle when they are within a section size of each other.
  const byKey = new Map(items.map(it => [`${it.scope ?? ''}/${it.id}`, it]));
  const itemOf = (id: string, scope?: string) => byKey.get(`${scope ?? ''}/${id}`);
  const kept: Clash[] = [];
  for (const c of [...found.values()].sort((x, y) => y.depth - x.depth)) {
    const A = itemOf(c.a, c.aScope);
    const dup = A?.cat === 'curve' && kept.some(k => {
      if (k.b !== c.b || k.bScope !== c.bScope || k.kind !== c.kind || k.a === c.a) return false;
      const K = itemOf(k.a, k.aScope);
      if (!K || K.cat !== 'curve' || !connected(A, K)) return false;
      return len(sub(k.at, c.at)) <= Math.max(A.size, K.size, tol) + 1e-6;
    });
    if (!dup) kept.push(c);
  }
  return kept.sort((x, y) => (x.minor ? 1 : 0) - (y.minor ? 1 : 0) || SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]
    || (x.kind === 'clearance' ? 1 : 0) - (y.kind === 'clearance' ? 1 : 0)
    || y.depth - x.depth || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/** Clash count per severity (minor overlaps within tolerance left out). */
export function clashCounts(clashes: readonly Clash[]): Record<ClashSeverity, number> {
  const out: Record<ClashSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const c of clashes) if (!c.minor) out[c.severity]++;
  return out;
}
