/**
 * Element facts (the same `geometry()` output the 3D view draws) → IFC
 * geometry IR in world coordinates. Pure functions, no IFC entities.
 */
import type { BufferGeometry } from 'three';
import type { Point } from '../../model/elements.ts';
import type { Shape2D } from '../../three/primitives/types.ts';
import { createProfile } from '../../three/primitives/profiles.ts';
import { pointOnArc, arcLength, type ArcParams } from '../../geometry/arc.ts';
import type { OpeningPart } from '../../elements/_opening3D.tsx';
import {
  type Frame, type Profile, type Solid, type V2, type V3,
  UP, add, cross, frameAt, frameY, memberFrame, normalize, planFrame, scale, sub, toWorld, v3,
} from './frame.ts';

/** World geometry of one product: placement frame + solids (+ optional axis curve). */
export interface ProductGeom {
  /** Local placement (world). Omitted → axis-aligned at the storey origin. */
  frame?: Frame;
  solids: Solid[];
  axis?: V3[];
}

// ─── Primitive builders ──────────────────────────────────────────────────────

/** Plan polygon extruded straight up from elevation `z0`. */
export function extrudePlan(vertices: V2[], z0: number, height: number, holes?: V2[][]): Solid {
  return {
    kind: 'extrude',
    profile: { kind: 'poly', outer: vertices, holes: holes && holes.length > 0 ? holes : undefined },
    frame: frameAt(v3(0, 0, z0)),
    depth: height,
  };
}

/** Upright box: plan centre `c`, bottom at `z0`, local X along plan angle. */
export function box(c: V2, z0: number, sx: number, sy: number, h: number, angle = 0): Solid {
  return {
    kind: 'extrude',
    profile: { kind: 'rect', w: sx, d: sy },
    frame: planFrame(v3(c.x, c.y, z0), angle),
    depth: h,
  };
}

/** Section swept along a straight 3D axis; profile local Y is "up" (see memberFrame). */
export function sweep(start: V3, end: V3, profile: Profile): Solid | null {
  const f = memberFrame(start, end);
  if (!f) return null;
  return { kind: 'extrude', profile, frame: f, depth: Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) };
}

/** Vertical-plane profile (u along `dir`, v up) extruded across `width`, centred on the line from `o`. */
function sideProfileSolid(o: V3, dir: V2, width: number, outer: V2[]): Solid {
  const left = { x: -dir.y, y: dir.x, z: 0 };
  // Profile plane: local X = run direction, local Z = right normal → local Y = up.
  return {
    kind: 'extrude',
    profile: { kind: 'poly', outer },
    frame: { o: add(o, scale(left, width / 2)), z: scale(left, -1), x: { x: dir.x, y: dir.y, z: 0 } },
    depth: width,
  };
}

/** three.js BufferGeometry (world Y up, plan Y = −Z) → closed brep faces. */
export function brepFromBuffer(geo: BufferGeometry): Solid | null {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const at = (i: number): V3 => {
    const k = index ? index.getX(i) : i;
    return v3(pos.getX(k), -pos.getZ(k), pos.getY(k));
  };
  const faces: V3[][] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const a = at(i), b = at(i + 1), c = at(i + 2);
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n.x, n.y, n.z) < 1e-12) continue; // degenerate sliver
    faces.push([a, b, c]);
  }
  return faces.length > 0 ? { kind: 'brep', faces } : null;
}

// ─── Sections ────────────────────────────────────────────────────────────────

/** Editor section shape → IFC profile, centred on the section origin like createProfile. */
export function sectionProfile(shape: Shape2D, name?: string): Profile {
  switch (shape.kind) {
    case 'rect': return { kind: 'rect', w: shape.width, d: shape.depth, name };
    case 'round': return { kind: 'circle', r: shape.radius, name };
    case 'i': return { kind: 'ishape', w: shape.width, d: shape.depth, web: shape.web, flange: shape.flange, name };
    default: {
      const pts = createProfile(shape).getPoints(12).map(p => ({ x: p.x, y: p.y }));
      return { kind: 'poly', outer: dedupeClosing(pts), name };
    }
  }
}

function dedupeClosing(pts: V2[]): V2[] {
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) return pts.slice(0, -1);
  }
  return pts;
}

/** Shift a centred profile so its top edge sits on the local X axis (beam line = member top). */
export function hangFromTop(p: Profile): Profile {
  switch (p.kind) {
    case 'rect': return { ...p, cy: (p.cy ?? 0) - p.d / 2 };
    case 'ishape': return { ...p, cy: (p.cy ?? 0) - p.d / 2 };
    case 'circle': return { ...p, cy: (p.cy ?? 0) - p.r };
    case 'poly': {
      const top = Math.max(...p.outer.map(v => v.y));
      const shift = (ring: V2[]) => ring.map(v => ({ x: v.x, y: v.y - top }));
      return { ...p, outer: shift(p.outer), holes: p.holes?.map(shift) };
    }
  }
}

// ─── Walls and their openings ────────────────────────────────────────────────

export interface WallLike {
  centerline: { start: Point; end: Point; arc?: ArcParams; length: number };
  footprint: Point[];
  thickness: number;
  height: number;
  baseY: number;
}

/** Wall: footprint (mitred corners, as drawn) extruded in a frame at the wall start, X along the chord. */
export function wallGeom(w: WallLike): ProductGeom {
  const { start, end } = w.centerline;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const frame = planFrame(v3(start.x, start.y, w.baseY), angle);
  const solid: Solid = {
    kind: 'extrude',
    profile: { kind: 'poly', outer: w.footprint.map(p => toPlanLocal(frame, p)) },
    frame,
    depth: w.height,
  };
  const axis = w.centerline.arc ? undefined : [v3(start.x, start.y, w.baseY), v3(end.x, end.y, w.baseY)];
  return { frame, solids: [solid], axis };
}

function toPlanLocal(f: Frame, p: Point): V2 {
  const dx = p.x - f.o.x, dy = p.y - f.o.y;
  return { x: dx * f.x.x + dy * f.x.y, y: -dx * f.x.y + dy * f.x.x };
}

/** Upright frame at the bottom-centre of a wall opening (X along the wall at that point). */
export function wallOpeningFrame(w: WallLike, position: number, sill: number): Frame {
  const { start, end, arc } = w.centerline;
  let p: Point, angle: number;
  if (arc) {
    const len = arcLength(start, end, arc);
    const t = len > 0.001 ? Math.max(0, Math.min(1, position / len)) : 0;
    const r = pointOnArc(start, end, arc, t);
    p = r.point;
    angle = Math.atan2(r.tangent.y, r.tangent.x);
  } else {
    const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const ux = (end.x - start.x) / len, uy = (end.y - start.y) / len;
    p = { x: start.x + ux * position, y: start.y + uy * position };
    angle = Math.atan2(uy, ux);
  }
  return planFrame(v3(p.x, p.y, w.baseY + sill), angle);
}

export type OpeningShape = 'rect' | 'round' | 'arch';

/** Void body: the opening outline in the wall plane, extruded through the wall with margin on both faces. */
export function wallOpeningSolid(f: Frame, width: number, height: number, thickness: number, shape: OpeningShape = 'rect'): Solid {
  const margin = Math.max(0.05, thickness / 2);
  const depth = thickness + 2 * margin;
  const left = frameY(f);
  let profile: Profile;
  if (shape === 'round') {
    profile = { kind: 'circle', r: Math.min(width, height) / 2, cy: height / 2 };
  } else if (shape === 'arch') {
    const hw = width / 2;
    const rectH = Math.max(height - hw, 0);
    const outer: V2[] = [{ x: -hw, y: 0 }, { x: hw, y: 0 }, { x: hw, y: rectH }];
    for (let i = 1; i < 16; i++) {
      const a = (Math.PI * i) / 16;
      outer.push({ x: hw * Math.cos(a), y: rectH + hw * Math.sin(a) });
    }
    outer.push({ x: -hw, y: rectH });
    profile = { kind: 'poly', outer };
  } else {
    profile = { kind: 'rect', w: width, d: height, cy: height / 2 };
  }
  return {
    kind: 'extrude',
    profile,
    // Local X along the wall, local Z through the wall (right normal) → local Y up.
    frame: { o: add(f.o, scale(left, depth / 2)), z: scale(left, -1), x: f.x },
    depth,
  };
}

/** Door / window parts (3D-view layout) → boxes in an opening frame (origin at the bottom centre). */
export function openingPartSolids(f: Frame, parts: OpeningPart[], height: number): { role: OpeningPart['role']; solid: Solid }[] {
  return parts.map(p => {
    const [sx, sy, sz] = p.size;
    const [px, py, pz] = p.pos;
    // three.js local Z (across) is the wall's right normal = −local Y here.
    const o = toWorld(f, v3(px, -pz, height / 2 + py - sy / 2));
    return {
      role: p.role,
      solid: { kind: 'extrude', profile: { kind: 'rect', w: sx, d: sz }, frame: { o, z: UP, x: f.x }, depth: sy },
    };
  });
}

// ─── Stairs, ramps, railings ─────────────────────────────────────────────────

const STAIR_WAIST = 0.15;

export interface RunLike { start: Point; end: Point; startZ: number; endZ: number; width: number; baseY: number }

/** A flight as a solid stepped profile (risers, treads and a sloped soffit), not floating treads. */
export function stairFlightGeom(r: RunLike & { stepCount: number }): ProductGeom | null {
  // Build the profile ascending: swap ends for a descending run.
  const up = r.endZ >= r.startZ;
  const lo = up ? r.start : r.end, hi = up ? r.end : r.start;
  const z0 = Math.min(r.startZ, r.endZ), rise = Math.abs(r.endZ - r.startZ);
  const len = Math.hypot(hi.x - lo.x, hi.y - lo.y);
  if (len < 0.001) return null;
  const dir = { x: (hi.x - lo.x) / len, y: (hi.y - lo.y) / len };
  const o = v3(lo.x, lo.y, r.baseY + z0);
  const n = Math.max(1, r.stepCount);
  if (rise < 0.01) {
    return { solids: [sideProfileSolid(o, dir, r.width, [{ x: 0, y: -STAIR_WAIST }, { x: len, y: -STAIR_WAIST }, { x: len, y: 0 }, { x: 0, y: 0 }])] };
  }
  const d = len / n, h = rise / n;
  const outer: V2[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < n; i++) {
    outer.push({ x: i * d, y: (i + 1) * h });
    outer.push({ x: (i + 1) * d, y: (i + 1) * h });
  }
  // Soffit: the pitch line dropped by the vertical waist, meeting the floor at u0.
  const waistV = Math.min(STAIR_WAIST * Math.hypot(d, h) / d, rise * 0.6);
  outer.push({ x: len, y: rise - waistV });
  outer.push({ x: (waistV * len) / rise, y: 0 });
  return { solids: [sideProfileSolid(o, dir, r.width, outer)] };
}

/** Ramp: a sloped slab of `thickness` following the run line (the 3D view approximates it flat). */
export function rampGeom(r: RunLike, thickness: number): ProductGeom | null {
  const len = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
  if (len < 0.001) return null;
  const dir = { x: (r.end.x - r.start.x) / len, y: (r.end.y - r.start.y) / len };
  const rise = r.endZ - r.startZ;
  const outer: V2[] = [{ x: 0, y: 0 }, { x: len, y: rise }, { x: len, y: rise - thickness }, { x: 0, y: -thickness }];
  return { solids: [sideProfileSolid(v3(r.start.x, r.start.y, r.baseY + r.startZ), dir, r.width, outer)] };
}

export interface RailingLike { start: Point; end: Point; startZ: number; endZ: number; height: number; baseY: number; horLen: number }

/** Railing: handrail swept along the (possibly sloped) top line + balusters spaced like the 3D view. */
export function railingGeom(r: RailingLike, opts = { spacing: 0.12, baluster: 0.025, handrail: 0.04 }): ProductGeom | null {
  if (r.horLen < 0.001) return null;
  const s = v3(r.start.x, r.start.y, r.baseY + r.startZ + r.height);
  const e = v3(r.end.x, r.end.y, r.baseY + r.endZ + r.height);
  const solids: Solid[] = [];
  const rail = sweep(s, e, { kind: 'rect', w: opts.handrail, d: opts.handrail });
  if (rail) solids.push(rail);
  const count = Math.max(2, Math.floor(r.horLen / opts.spacing) + 1);
  const angle = Math.atan2(r.end.y - r.start.y, r.end.x - r.start.x);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const c = { x: r.start.x + (r.end.x - r.start.x) * t, y: r.start.y + (r.end.y - r.start.y) * t };
    const z = r.baseY + r.startZ + (r.endZ - r.startZ) * t;
    solids.push(box(c, z, opts.baluster, opts.baluster, r.height, angle));
  }
  return { solids };
}

// ─── Curtain walls ───────────────────────────────────────────────────────────

export interface CurtainWallLike {
  start: Point; end: Point; length: number; angle: number;
  uGridCount: number; vGridCount: number; height: number; baseY: number;
}

export interface CurtainPart { kind: 'mullion' | 'transom' | 'panel'; index: string; solid: Solid }

/** Mullions, transoms and panels at the same positions / sizes as the 3D view. */
export function curtainWallParts(cw: CurtainWallLike, mullion = 0.05, panel = 0.006): CurtainPart[] {
  const ux = Math.cos(cw.angle), uy = Math.sin(cw.angle);
  const at = (t: number) => ({ x: cw.start.x + ux * t, y: cw.start.y + uy * t });
  const cellW = cw.length / cw.uGridCount;
  const cellH = cw.height / cw.vGridCount;
  const parts: CurtainPart[] = [];
  for (let i = 0; i <= cw.uGridCount; i++) {
    parts.push({ kind: 'mullion', index: `${i}`, solid: box(at(i * cellW), cw.baseY, mullion, mullion, cw.height, cw.angle) });
  }
  for (let j = 0; j <= cw.vGridCount; j++) {
    parts.push({ kind: 'transom', index: `${j}`, solid: box(at(cw.length / 2), cw.baseY + j * cellH - mullion / 2, cw.length, mullion, mullion, cw.angle) });
  }
  const pw = cellW - mullion, ph = cellH - mullion;
  if (pw > 0.01 && ph > 0.01) {
    for (let i = 0; i < cw.uGridCount; i++) {
      for (let j = 0; j < cw.vGridCount; j++) {
        parts.push({
          kind: 'panel', index: `${i}_${j}`,
          solid: box(at((i + 0.5) * cellW), cw.baseY + (j + 0.5) * cellH - ph / 2, pw, panel, ph, cw.angle),
        });
      }
    }
  }
  return parts;
}

// ─── MEP fittings ────────────────────────────────────────────────────────────

export interface FittingLeg {
  /** Unit direction from the node centre along the connected segment. */
  dir: V3;
  /** Distance from the node centre to the segment's near end (Revit leaves a gap; drawn runs touch). */
  gap: number;
  round: boolean;
  sizeX: number;
  sizeY: number;
}

/**
 * Passive fitting body: one stub per connected segment, each the segment's own
 * section, starting half a section behind the centre (so corners close) and
 * reaching the segment end — an elbow bends, a tee branches, a reducer steps.
 */
export function fittingStubs(center: V3, legs: FittingLeg[]): Solid[] {
  const reach = Math.max(...legs.map(l => Math.max(l.sizeX, l.sizeY))) / 2;
  const out: Solid[] = [];
  for (const l of legs) {
    const back = Math.max(l.sizeX, l.sizeY) / 2;
    const s = add(center, scale(l.dir, -back));
    const e = add(center, scale(l.dir, Math.max(l.gap, reach)));
    const profile: Profile = l.round ? { kind: 'circle', r: l.sizeX / 2 } : { kind: 'rect', w: l.sizeX, d: l.sizeY };
    const solid = sweep(s, e, profile);
    if (solid) out.push(solid);
  }
  return out;
}

export { normalize };
