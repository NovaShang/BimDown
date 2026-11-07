/**
 * Model → triangle meshes + drawable edges for section and elevation drawings.
 *
 * Bodies come from the element modules' `geometry()` facts through the same
 * solid builders the IFC export uses (`export/ifc/geometry.ts`), so a section
 * shows exactly the walls, slabs, stairs and frames the 3D view and IFC hold.
 * Walls are the exception: their mesh is the editor's own solid with door /
 * window voids, and their outline edges are built analytically (faces, ends,
 * opening reveals) so the seams between the wall's prism pieces never show.
 *
 * Every part carries its triangles (occluders, and the input of the section
 * cut) and its edges: `sharp` edges are always drawn when visible, `smooth`
 * ones (between facets of a curved surface) only where they are a silhouette.
 * Coordinates are plan x / y with z = absolute elevation, project units.
 */
import '../../elements/registerAll.ts';
import { ShapeUtils, Vector2, type BufferGeometry } from 'three';
import type { CanonicalElement, LineElement, PolygonElement } from '../../model/elements.ts';
import type { Level, ProjectData } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import { getElementModule } from '../../elements/registry.ts';
import { parseFloorLayers } from '../../model/parse.ts';
import { buildGeometryContext } from '../../adapters/svg/buildContext.ts';
import { roofGeometryFromSolution } from '../../three/utils/roofGeometry.ts';
import { buildCrossLevelIndex } from '../../model/crossLevel.ts';
import { repZ, type StairRepetition } from '../../geometry/stair.ts';
import type { StairLandingFacts } from '../../elements/stair_landing.tsx';
import { wallSolidGeometry, type LineWallFacts } from '../../elements/_lineWallShared.tsx';
import type { SlabFacts } from '../../elements/_slabShared.tsx';
import type { RoofFacts } from '../../elements/roof.tsx';
import type { ColumnFacts } from '../../elements/column.tsx';
import { memberBodyEnds, type BeamFacts } from '../../elements/beam.tsx';
import type { FoundationFacts } from '../../elements/foundation.tsx';
import type { StairFacts } from '../../elements/stair.tsx';
import type { StairRunFacts } from '../../elements/stair_run.tsx';
import type { RailingFacts } from '../../elements/railing.tsx';
import type { RampFacts } from '../../elements/ramp.tsx';
import type { CurtainWallFacts } from '../../elements/curtain_wall.tsx';
import type { EquipmentFacts } from '../../elements/equipment.tsx';
import { doorParts, windowParts } from '../../elements/_opening3D.tsx';
import type { Frame, Profile, Solid, V2, V3 } from '../ifc/frame.ts';
import { cross, frameY, planFrame, v3 } from '../ifc/frame.ts';
import { getProjectUnits } from '../../utils/units.ts';
import { unitsPerMetre } from './plan.ts';
import { furnitureSolids, mepNodeSolids, mepRunSolid } from '../ifc/componentSolids.ts';
import type { FurnitureFacts } from '../../elements/furniture.tsx';
import type { MepNodeFacts } from '../../elements/mep_node.tsx';
import {
  box, brepFromBuffer, curtainWallParts, extrudePlan, hangFromTop, openingPartSolids, railingGeom, rampGeom,
  sectionProfile, stairFlightGeom, sweep, wallOpeningFrame,
} from '../ifc/geometry.ts';

/** Drawing class of a part: decides poché, pen and layer. */
export type PartClass =
  | 'wall' | 'swall' | 'slab' | 'sslab' | 'roof' | 'ceiling' | 'column' | 'scolumn' | 'beam'
  | 'foundation' | 'stair' | 'railing' | 'curtain' | 'door' | 'window' | 'glass' | 'equipment'
  | 'mep' | 'furniture';

/** Edge between two facets of a curved surface: drawn only where the surface turns away from the viewer. */
export interface SmoothEdge { a: V3; b: V3; n1: V3; n2: V3 }

export interface ViewPart {
  /** Element id (global elements prefixed `global:`). */
  id: string;
  table: string;
  cls: PartClass;
  /** Triangles, 9 numbers each (x, y, z × 3). */
  tris: number[];
  /** Edges always drawn when visible, 6 numbers each. */
  sharp: number[];
  smooth: SmoothEdge[];
}

const SHARP_DEG = 25;
const SHARP_COS = Math.cos((SHARP_DEG * Math.PI) / 180);

// ─── Small vector helpers ───────────────────────────────────────────────────

const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len3 = (a: V3) => Math.hypot(a.x, a.y, a.z);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Frame-local (u, v, w) → world. */
function toWorld(f: Frame, y: V3, u: number, v: number, w: number): V3 {
  return {
    x: f.o.x + f.x.x * u + y.x * v + f.z.x * w,
    y: f.o.y + f.x.y * u + y.y * v + f.z.y * w,
    z: f.o.z + f.x.z * u + y.z * v + f.z.z * w,
  };
}

function signedArea(r: V2[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[j].y + r[i].y);
  return s / 2;
}

/** Profile → outer ring (CCW) + holes (CW), local XY. */
export function profileRings(p: Profile): { outer: V2[]; holes: V2[][]; smooth: boolean } {
  const cx = p.kind === 'poly' ? 0 : p.cx ?? 0, cy = p.kind === 'poly' ? 0 : p.cy ?? 0;
  let outer: V2[];
  let holes: V2[][] = [];
  let smooth = false;
  switch (p.kind) {
    case 'rect':
      outer = [{ x: cx - p.w / 2, y: cy - p.d / 2 }, { x: cx + p.w / 2, y: cy - p.d / 2 }, { x: cx + p.w / 2, y: cy + p.d / 2 }, { x: cx - p.w / 2, y: cy + p.d / 2 }];
      break;
    case 'circle': {
      const n = 32;
      outer = Array.from({ length: n }, (_, i) => ({ x: cx + p.r * Math.cos((i / n) * Math.PI * 2), y: cy + p.r * Math.sin((i / n) * Math.PI * 2) }));
      smooth = true;
      break;
    }
    case 'ishape': {
      const hw = p.w / 2, hd = p.d / 2, tw = p.web / 2, tf = p.flange;
      outer = [
        { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: -hd + tf }, { x: tw, y: -hd + tf },
        { x: tw, y: hd - tf }, { x: hw, y: hd - tf }, { x: hw, y: hd }, { x: -hw, y: hd },
        { x: -hw, y: hd - tf }, { x: -tw, y: hd - tf }, { x: -tw, y: -hd + tf }, { x: -hw, y: -hd + tf },
      ].map(q => ({ x: q.x + cx, y: q.y + cy }));
      break;
    }
    case 'ushape': {
      const hw = p.w / 2, hd = p.d / 2, tf = p.flange, tw = p.web;
      outer = [
        { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: -hd + tf }, { x: -hw + tw, y: -hd + tf },
        { x: -hw + tw, y: hd - tf }, { x: hw, y: hd - tf }, { x: hw, y: hd }, { x: -hw, y: hd },
      ].map(q => ({ x: q.x + cx, y: q.y + cy }));
      break;
    }
    case 'lshape': {
      const hw = p.w / 2, hd = p.d / 2, t = p.t;
      outer = [
        { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: -hd + t }, { x: -hw + t, y: -hd + t }, { x: -hw + t, y: hd }, { x: -hw, y: hd },
      ].map(q => ({ x: q.x + cx, y: q.y + cy }));
      break;
    }
    case 'rect_hollow': {
      const box = (hw: number, hd: number) => [{ x: cx - hw, y: cy - hd }, { x: cx + hw, y: cy - hd }, { x: cx + hw, y: cy + hd }, { x: cx - hw, y: cy + hd }];
      outer = box(p.w / 2, p.d / 2);
      holes = [box(p.w / 2 - p.t, p.d / 2 - p.t)];
      break;
    }
    case 'circle_hollow': {
      const n = 32;
      const ring = (r: number) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * Math.PI * 2), y: cy + r * Math.sin((i / n) * Math.PI * 2) }));
      outer = ring(p.r);
      holes = [ring(p.r - p.t)];
      smooth = true;
      break;
    }
    default:
      outer = p.outer.map(q => ({ x: q.x + cx, y: q.y + cy }));
      holes = (p.holes ?? []).map(h => h.map(q => ({ x: q.x + cx, y: q.y + cy })));
  }
  // Outer counter-clockwise, holes clockwise (signedArea > 0 ⇔ counter-clockwise)
  if (signedArea(outer) < 0) outer = [...outer].reverse();
  holes = holes.map(h => (signedArea(h) > 0 ? [...h].reverse() : h));
  return { outer, holes, smooth };
}

// ─── Tessellation ───────────────────────────────────────────────────────────

class PartBuilder {
  readonly tris: number[] = [];
  readonly sharp: number[] = [];
  readonly smooth: SmoothEdge[] = [];

  tri(a: V3, b: V3, c: V3) {
    this.tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  edge(a: V3, b: V3) {
    if (len3(sub3(a, b)) < 1e-9) return;
    this.sharp.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  /** Extruded profile: caps, sides, cap ring edges, sharp side edges, smooth silhouettes. */
  extrude(s: Extract<Solid, { kind: 'extrude' }>, edges = true) {
    const f = s.frame;
    const y = frameY(f);
    const { outer, holes, smooth } = profileRings(s.profile);
    if (outer.length < 3) return;
    const rings = [outer, ...holes];
    const all = rings.flat();
    const at = (p: V2, w: number) => toWorld(f, y, p.x, p.y, w);
    const faces = ShapeUtils.triangulateShape(outer.map(p => new Vector2(p.x, p.y)), holes.map(h => h.map(p => new Vector2(p.x, p.y))));
    for (const [i, j, k] of faces) {
      // Caps wound outward: the top along the frame's +Z, the bottom against it
      const p = all[i], q = all[j], r = all[k];
      const ccw = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y) > 0;
      const [b1, c1] = ccw ? [q, r] : [r, q];
      this.tri(at(p, 0), at(c1, 0), at(b1, 0));
      this.tri(at(p, s.depth), at(b1, s.depth), at(c1, s.depth));
    }
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const a0 = at(p, 0), b0 = at(q, 0), a1 = at(p, s.depth), b1 = at(q, s.depth);
        this.tri(a0, b0, b1);
        this.tri(a0, b1, a1);
        if (!edges) continue;
        this.edge(a0, b0);
        this.edge(a1, b1);
      }
      if (!edges) continue;
      // Side edges at the ring vertices
      for (let i = 0; i < n; i++) {
        const prev = ring[(i - 1 + n) % n], p = ring[i], next = ring[(i + 1) % n];
        const e1 = { x: p.x - prev.x, y: p.y - prev.y }, e2 = { x: next.x - p.x, y: next.y - p.y };
        const l1 = Math.hypot(e1.x, e1.y), l2 = Math.hypot(e2.x, e2.y);
        if (l1 < 1e-12 || l2 < 1e-12) continue;
        const cos = (e1.x * e2.x + e1.y * e2.y) / (l1 * l2);
        const a = at(p, 0), b = at(p, s.depth);
        if (!smooth && cos < SHARP_COS) { this.edge(a, b); continue; }
        // Outward side normals of the two faces (local), mapped to world directions
        const nl = (e: V2, l: number) => ({ x: e.y / l, y: -e.x / l });
        const toDir = (d: V2) => norm3(sub3(toWorld(f, y, d.x, d.y, 0), f.o));
        this.smooth.push({ a, b, n1: toDir(nl(e1, l1)), n2: toDir(nl(e2, l2)) });
      }
    }
  }

  /** Closed polygon faces (outward) → fan triangles; edges between faces by angle. */
  faces(faces: V3[][]) {
    const key = (p: V3) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
    const edgeMap = new Map<string, { a: V3; b: V3; normals: V3[] }>();
    for (const face of faces) {
      if (face.length < 3) continue;
      let n: V3 = { x: 0, y: 0, z: 0 };
      for (let i = 1; i + 1 < face.length; i++) {
        const c = cross(sub3(face[i], face[0]), sub3(face[i + 1], face[0]));
        n = { x: n.x + c.x, y: n.y + c.y, z: n.z + c.z };
        this.tri(face[0], face[i], face[i + 1]);
      }
      if (len3(n) < 1e-14) continue;
      n = norm3(n);
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        const ka = key(a), kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const e = edgeMap.get(k);
        if (e) e.normals.push(n);
        else edgeMap.set(k, { a, b, normals: [n] });
      }
    }
    for (const { a, b, normals } of edgeMap.values()) {
      if (normals.length !== 2) { this.edge(a, b); continue; }
      const c = dot3(normals[0], normals[1]);
      if (c > 0.9998) continue; // coplanar triangulation diagonal
      if (c < SHARP_COS) this.edge(a, b);
      else this.smooth.push({ a, b, n1: normals[0], n2: normals[1] });
    }
  }

  solid(s: Solid, edges = true) {
    if (s.kind === 'extrude') this.extrude(s, edges);
    else this.faces(s.faces);
  }

  /** three.js geometry (world Y up, plan y = −z) → triangles only. */
  buffer(geo: BufferGeometry) {
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number): V3 => {
      const k = index ? index.getX(i) : i;
      return v3(pos.getX(k), -pos.getZ(k), pos.getY(k));
    };
    for (let i = 0; i + 2 < count; i += 3) this.tri(at(i), at(i + 1), at(i + 2));
  }

  part(id: string, table: string, cls: PartClass): ViewPart {
    return { id, table, cls, tris: this.tris, sharp: this.sharp, smooth: this.smooth };
  }
}

// ─── Walls ──────────────────────────────────────────────────────────────────

/** Straight wall outline: footprint edges at the base and top, vertical corners, opening reveals on both faces. */
function straightWallEdges(b: PartBuilder, f: LineWallFacts) {
  const { start, end } = f.centerline;
  const L = Math.hypot(end.x - start.x, end.y - start.y);
  if (L < 1e-6) return;
  const u = { x: (end.x - start.x) / L, y: (end.y - start.y) / L };
  const n = { x: -u.y, y: u.x };
  const z0 = f.baseY, z1 = f.baseY + f.height;
  const tOf = (p: V2) => (p.x - start.x) * u.x + (p.y - start.y) * u.y;
  const sOf = (p: V2) => (p.x - start.x) * n.x + (p.y - start.y) * n.y;
  const ops = f.openings.map(o => ({ lo: o.position - o.width / 2, hi: o.position + o.width / 2, sill: o.sillHeight, head: o.sillHeight + o.height }));
  const fp = f.footprint;
  const eps = 1e-6 + f.thickness * 1e-4;
  /** Spans of [t0, t1] not interrupted by openings reaching height `z` (bottom or top edge). */
  const cutSpans = (t0: number, t1: number, z: number): [number, number][] => {
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    let spans: [number, number][] = [[lo, hi]];
    for (const o of ops) {
      const touches = z === z0 ? o.sill <= eps : o.head >= f.height - eps;
      if (!touches) continue;
      spans = spans.flatMap(([a, c]) => {
        if (o.hi <= a || o.lo >= c) return [[a, c] as [number, number]];
        const out: [number, number][] = [];
        if (o.lo > a) out.push([a, o.lo]);
        if (o.hi < c) out.push([o.hi, c]);
        return out;
      });
    }
    return spans;
  };
  const P = (t: number, s: number, z: number): V3 => v3(start.x + u.x * t + n.x * s, start.y + u.y * t + n.y * s, z);
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i], q = fp[(i + 1) % fp.length];
    const tp = tOf(p), tq = tOf(q), sp = sOf(p), sq = sOf(q);
    const alongFace = Math.abs(tq - tp) > eps && Math.abs(sq - sp) < Math.abs(tq - tp) * 0.2;
    for (const z of [z0, z1]) {
      if (!alongFace) { b.edge(v3(p.x, p.y, z), v3(q.x, q.y, z)); continue; }
      for (const [a, c] of cutSpans(tp, tq, z)) {
        // Interpolate s along the edge for mitred faces
        const sa = sp + ((sq - sp) * (a - tp)) / (tq - tp), sc = sp + ((sq - sp) * (c - tp)) / (tq - tp);
        b.edge(P(a, sa, z), P(c, sc, z));
      }
    }
    b.edge(v3(p.x, p.y, z0), v3(p.x, p.y, z1));
  }
  // Openings: rectangle on both faces + reveal edges through the wall
  const h = f.thickness / 2;
  for (const o of ops) {
    const lo = Math.max(o.lo, Math.min(...fp.map(tOf))), hi = Math.min(o.hi, Math.max(...fp.map(tOf)));
    if (hi - lo < eps) continue;
    const zs = z0 + o.sill, zh = z0 + Math.min(o.head, f.height);
    for (const s of [-h, h]) {
      b.edge(P(lo, s, zs), P(lo, s, zh));
      b.edge(P(hi, s, zs), P(hi, s, zh));
      if (o.sill > eps) b.edge(P(lo, s, zs), P(hi, s, zs));
      if (o.head < f.height - eps) b.edge(P(lo, s, zh), P(hi, s, zh));
    }
    for (const t of [lo, hi]) {
      if (o.sill > eps) b.edge(P(t, -h, zs), P(t, h, zs));
      if (o.head < f.height - eps) b.edge(P(t, -h, zh), P(t, h, zh));
    }
  }
}

function wallPart(id: string, el: CanonicalElement, f: LineWallFacts, ctx: GeometryContext, out: ViewPart[]) {
  if (f.footprint.length < 3 || !(f.height > 0)) return;
  const b = new PartBuilder();
  const geo = wallSolidGeometry(f);
  b.buffer(geo);
  geo.dispose();
  if (!f.centerline.arc) straightWallEdges(b, f);
  else {
    // Arc wall: edges from the extruded footprint (smooth face facets), openings omitted
    const e = new PartBuilder();
    e.solid(extrudePlan(f.footprint, f.baseY, f.height));
    b.sharp.push(...e.sharp);
    b.smooth.push(...e.smooth);
  }
  out.push(b.part(id, el.tableName, el.tableName === 'structure_wall' ? 'swall' : 'wall'));
  // Hosted doors / windows: their frames and leaves in the wall void
  for (const op of f.openings) {
    if (op.hostedTable === 'opening') continue;
    const hosted = ctx.elementById(op.hostedId);
    if (!hosted) continue;
    const frame = wallOpeningFrame(f, op.position, op.sillHeight);
    const isDoor = op.hostedTable === 'door';
    const operation = hosted.attrs.operation || (isDoor ? 'single_swing' : 'fixed');
    const parts = (isDoor ? doorParts : windowParts)({ length: op.width, height: op.height, strokeWidth: f.thickness, operation });
    const pb = new PartBuilder(), gb = new PartBuilder();
    for (const s of openingPartSolids(frame, parts, op.height)) (s.role === 'glass' ? gb : pb).solid(s.solid);
    const hid = id.startsWith('global:') ? `global:${op.hostedId}` : op.hostedId;
    out.push(pb.part(hid, op.hostedTable, isDoor ? 'door' : 'window'));
    if (gb.tris.length) out.push(gb.part(hid, op.hostedTable, 'glass'));
  }
}

// ─── Other elements ─────────────────────────────────────────────────────────

function solidsPart(id: string, table: string, cls: PartClass, solids: (Solid | null | undefined)[]): ViewPart | null {
  const b = new PartBuilder();
  for (const s of solids) if (s) b.solid(s);
  return b.tris.length ? b.part(id, table, cls) : null;
}

function foundationSolid(f: FoundationFacts): Solid {
  if (f.form === 'point') {
    return f.round
      ? { kind: 'extrude', profile: { kind: 'circle', r: f.width / 2 }, frame: planFrame(v3(f.position.x, f.position.y, f.baseY), 0), depth: f.thickness }
      : box(f.position, f.baseY, f.width, f.depth, f.thickness, (f.rotationDeg * Math.PI) / 180);
  }
  if (f.form === 'line') return extrudePlan(f.footprint2D, f.baseY, f.thickness);
  return extrudePlan(f.vertices, f.baseY, f.thickness, f.holes);
}

const BASE_REP: StairRepetition = { index: 0, levelId: '', dz: 0, scale: 1 };
/** A run moved into one multi-storey repetition (as the IFC export does). */
function repRun<T extends { startZ: number; endZ: number }>(f: T, rep: StairRepetition): T {
  return rep.index === 0 ? f : { ...f, startZ: repZ(rep, f.startZ), endZ: repZ(rep, f.endZ) };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- facts are typed per table below */
function elementParts(id: string, el: CanonicalElement, facts: any, ctx: GeometryContext, hasRuns: (id: string) => boolean, out: ViewPart[]) {
  const t = el.tableName;
  const push = (p: ViewPart | null) => { if (p) out.push(p); };
  switch (t) {
    case 'wall': case 'structure_wall':
      wallPart(id, el, facts as LineWallFacts, ctx, out);
      break;
    case 'slab': case 'structure_slab': case 'ceiling': {
      const f = facts as SlabFacts;
      if (f.vertices.length < 3) break;
      push(solidsPart(id, t, t === 'slab' ? 'slab' : t === 'ceiling' ? 'ceiling' : 'sslab', [extrudePlan(f.vertices, f.baseY, f.thickness, f.holes)]));
      break;
    }
    case 'roof': {
      const f = facts as RoofFacts;
      if (f.vertices.length < 3) break;
      let solid: Solid | null = null;
      if (f.slopeDeg > 0) {
        // The footprint roof solver's planes (edge slopes, gables, hips), as the 3D view and IFC
        const geo = roofGeometryFromSolution(f.solution, f.vertices.map(p => ({ x: p.x, y: p.y })), f.baseY, f.thickness, (el as PolygonElement).holes ?? []);
        solid = geo ? brepFromBuffer(geo) : null;
        geo?.dispose();
      }
      push(solidsPart(id, t, 'roof', [solid ?? extrudePlan(f.vertices, f.baseY, f.thickness, f.holes)]));
      break;
    }
    case 'foundation':
      push(solidsPart(id, t, 'foundation', [foundationSolid(facts as FoundationFacts)]));
      break;
    case 'column': case 'structure_column': {
      const f = facts as ColumnFacts;
      const profile = sectionProfile(f.section.family.shape3D(f.section.params), f.section.family.id);
      const frame = planFrame(v3(f.position.x, f.position.y, f.baseY), (f.rotationDeg * Math.PI) / 180);
      push(solidsPart(id, t, t === 'column' ? 'column' : 'scolumn', [{ kind: 'extrude', profile, frame, depth: f.extrudeHeight }]));
      break;
    }
    case 'beam': case 'brace': {
      const f = facts as BeamFacts;
      const b = memberBodyEnds(f);
      const start = v3(b.start.x, b.start.y, f.baseY + b.startZ);
      const end = v3(b.end.x, b.end.y, f.baseY + b.endZ);
      const profile = hangFromTop(sectionProfile(f.section.family.shape3D(f.section.params), f.section.family.id));
      push(solidsPart(id, t, 'beam', [sweep(start, end, profile)]));
      break;
    }
    case 'stair': case 'stair_run': {
      if (t === 'stair' && hasRuns(el.id)) break;
      // Every storey of a multi-storey stair
      const f = facts as StairFacts | StairRunFacts;
      push(solidsPart(id, t, 'stair', (f.reps ?? [BASE_REP]).flatMap(rep => stairFlightGeom(repRun(f, rep))?.solids ?? [])));
      break;
    }
    case 'stair_landing': {
      const f = facts as StairLandingFacts;
      if (!f.vertices || f.vertices.length < 3) break;
      push(solidsPart(id, t, 'stair', (f.reps ?? [BASE_REP]).map(rep => {
        const top = rep.index === 0 ? f.baseY : f.levelY + repZ(rep, f.landing.top);
        return extrudePlan(f.vertices, top - f.thickness, f.thickness);
      })));
      break;
    }
    case 'railing': {
      const f = facts as RailingFacts;
      push(solidsPart(id, t, 'railing', f.paths.flatMap(segs => railingGeom(segs, f.baseY, f.style)?.solids ?? [])));
      break;
    }
    case 'ramp': {
      const f = facts as RampFacts;
      push(solidsPart(id, t, 'stair', rampGeom({ ...f, baseY: ctx.levelElevation }, 0.15)?.solids ?? []));
      break;
    }
    case 'curtain_wall': {
      const f = facts as CurtainWallFacts;
      const parts = curtainWallParts(f);
      push(solidsPart(id, t, 'curtain', parts.filter(p => p.kind !== 'panel').map(p => p.solid)));
      push(solidsPart(id, t, 'glass', parts.filter(p => p.kind === 'panel').map(p => p.solid)));
      break;
    }
    case 'duct': case 'pipe': case 'cable_tray': case 'conduit':
      push(solidsPart(id, t, 'mep', [mepRunSolid(el, ctx)]));
      break;
    case 'mep_node':
      push(solidsPart(id, t, 'mep', mepNodeSolids(facts as MepNodeFacts)));
      break;
    case 'furniture':
      push(solidsPart(id, t, 'furniture', furnitureSolids(facts as FurnitureFacts).map(x => x.solid)));
      break;
    case 'equipment': case 'terminal': {
      const f = facts as EquipmentFacts;
      push(solidsPart(id, t, 'equipment', [box(f.position, f.baseY, f.width, f.depth, f.height, (f.rotationDeg * Math.PI) / 180)]));
      break;
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Tables a section or elevation draws. */
const VIEW_TABLES = new Set([
  'wall', 'structure_wall', 'slab', 'structure_slab', 'ceiling', 'roof', 'foundation', 'column', 'structure_column',
  'beam', 'brace', 'stair', 'stair_run', 'stair_landing', 'railing', 'ramp', 'curtain_wall', 'equipment', 'terminal',
  'duct', 'pipe', 'cable_tray', 'conduit', 'mep_node', 'furniture',
]);

export interface ViewModelInput {
  project: ProjectData;
  /** Live (unsaved) elements of the level open in the editor, replacing its stored floor. */
  live?: { levelId: string; elements: Iterable<CanonicalElement> };
}

/** Every drawable part of the building, all levels and global/. */
export function collectViewParts(input: ViewModelInput): ViewPart[] {
  const { project } = input;
  const allLevels = project.levels;
  const upm = unitsPerMetre(getProjectUnits({ project }));
  const out: ViewPart[] = [];
  const scopes: { id: string; level: Level; elements: CanonicalElement[]; baseOf: (el: CanonicalElement) => number }[] = [];
  for (const level of allLevels) {
    let elements: CanonicalElement[];
    if (input.live && input.live.levelId === level.id) elements = [...input.live.elements].filter(e => e.tableName !== 'grid');
    else {
      const floor = project.floors.get(level.id);
      if (!floor) continue;
      elements = parseFloorLayers(floor.layers);
    }
    scopes.push({ id: level.id, level, elements, baseOf: () => level.elevation });
  }
  if (project.globalLayers.length && allLevels.length) {
    const byId = new Map(allLevels.map(l => [l.id, l.elevation]));
    const lowest = [...allLevels].sort((a, b) => a.elevation - b.elevation)[0];
    scopes.push({
      id: 'global', level: { ...lowest, elevation: 0 }, elements: parseFloorLayers(project.globalLayers),
      baseOf: el => (el.geometry === 'spatial_line' || el.tableName === 'beam' || el.tableName === 'brace'
        ? 0 : byId.get(el.attrs.base_level_id ?? '') ?? 0),
    });
  }
  // Roofs / slabs / shafts of every level: walls attached to a roof above, shafts through floors
  const crossLevel = buildCrossLevelIndex(project);
  for (const scope of scopes) {
    const allElements = new Map(scope.elements.map(e => [e.id, e]));
    const ctxCache = new Map<number, GeometryContext>();
    const ctxAt = (elevation: number) => {
      let c = ctxCache.get(elevation);
      if (!c) {
        c = buildGeometryContext({ level: { ...scope.level, elevation }, allLevels, allElements, mepSystems: project.mepSystems, types: project.types, unitsPerMetre: upm, crossLevel });
        ctxCache.set(elevation, c);
      }
      return c;
    };
    const runHosts = new Set(scope.elements.filter(e => e.tableName === 'stair_run').map(e => e.attrs.host_id || e.hostId || ''));
    for (const el of scope.elements) {
      if (!VIEW_TABLES.has(el.tableName) || el.attrs.mesh_file) continue;
      const mod = getElementModule(el.tableName);
      if (!mod) continue;
      const ctx = ctxAt(scope.baseOf(el));
      let facts: unknown = null;
      try { facts = mod.geometry(el, ctx); } catch { facts = null; }
      if (!facts) continue;
      const id = scope.id === 'global' ? `global:${el.id}` : el.id;
      try { elementParts(id, el, facts, ctx, hid => runHosts.has(hid), out); } catch (err) { console.warn(`[section] skipped ${el.id}`, err); }
    }
  }
  return out;
}

/** Plan-line elements usable as dimension snap targets etc. are not needed here; re-exported for tests. */
export type { LineElement };
