/**
 * Section and elevation drawings: vector line work generated from the model.
 *
 * A view looks along a horizontal direction; drawing coordinates are
 * x = p·right (along the view) and y = z (absolute elevation), project units.
 * Sections cut the model at their line: what the plane cuts is drawn as poché
 * with a heavy outline (sliced from the element meshes, adjacent pieces of the
 * same kind merged), everything beyond in projection lines with exact hidden
 * line removal against the visible triangles (hidden lines optional, dashed).
 * Elevations are the same without a cut. On top: ground line, level lines
 * with heads, grid lines with bubbles and the view's own annotations
 * (dimensions / text notes whose `view_id` is this view), sized for paper.
 *
 * The result is a `ViewDrawing`: the same item model as plans, so the PDF,
 * DXF and on-screen (SVG) writers draw it like any other sheet view.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { CanonicalElement, Point } from '../../model/elements.ts';
import type { GridData, ProjectData, ProjectUnit } from '../../types.ts';
import type { ElevationDir, OpenView, SectionDef } from '../../views/viewTypes.ts';
import { viewFrame, gridMarks, levelLines, formatLevelElevation, type P2 } from '../../views/viewGeometry.ts';
import { getProjectUnits } from '../../utils/units.ts';
import { parseLayer } from '../../model/parse.ts';
import { collectViewParts, type PartClass, type ViewModelInput, type ViewPart } from './viewSolids.ts';
import { LAYERS, type DrawingLayer } from './layers.ts';
import { itemsBounds, paperMm, unitsPerMetre } from './plan.ts';
import { annotationItems } from '../annotationExport.ts';
import { drawingLabel, type DrawingLang } from './labels.ts';
import type { Box, DrawItem, ViewDrawing } from './types.ts';

// ─── Layers (AIA / NCS section and elevation layers) ────────────────────────

const L = (name: string, color: string, aci: number, weight: number, dash: DrawingLayer['dash'], description: string): DrawingLayer =>
  ({ name, color, aci, weight, dash, description });

export const VIEW_LAYERS = {
  cut:      L('A-SECT-MCUT', '#000000', 7, 0.5,  'solid',  'Section: material cut outline'),
  cutPatt:  L('A-SECT-PATT', '#4d4d4d', 8, 0.05, 'solid',  'Section: cut poché'),
  sCutPatt: L('S-SECT-PATT', '#1f1f1f', 7, 0.05, 'solid',  'Section: structural cut poché'),
  beyond:   L('A-SECT-MBND', '#1a1a1a', 7, 0.18, 'solid',  'Section: material beyond'),
  elev:     L('A-ELEV-OTLN', '#1a1a1a', 7, 0.18, 'solid',  'Elevation: outlines'),
  glass:    L('A-ELEV-GLAZ', '#4a4a4a', 8, 0.13, 'solid',  'Elevation: glazing'),
  hidden:   L('A-SECT-HIDN', '#6b6b6b', 8, 0.13, 'hidden', 'Hidden lines'),
  ground:   L('A-SECT-GRND', '#000000', 7, 0.7,  'solid',  'Ground line'),
  level:    L('A-ANNO-LEVL', '#333333', 7, 0.13, 'center', 'Level lines'),
  levelId:  L('A-ANNO-LEVL-IDEN', '#1a1a1a', 7, 0.25, 'solid', 'Level heads'),
} satisfies Record<string, DrawingLayer>;

/** Poché per cut class; undefined = outline only. */
const CUT_FILL: Partial<Record<PartClass, { layer: DrawingLayer; color: string }>> = {
  wall: { layer: VIEW_LAYERS.cutPatt, color: '#4d4d4d' },
  slab: { layer: VIEW_LAYERS.cutPatt, color: '#4d4d4d' },
  roof: { layer: VIEW_LAYERS.cutPatt, color: '#4d4d4d' },
  ceiling: { layer: VIEW_LAYERS.cutPatt, color: '#8c8c8c' },
  stair: { layer: VIEW_LAYERS.cutPatt, color: '#4d4d4d' },
  column: { layer: VIEW_LAYERS.cutPatt, color: '#4d4d4d' },
  swall: { layer: VIEW_LAYERS.sCutPatt, color: '#1f1f1f' },
  sslab: { layer: VIEW_LAYERS.sCutPatt, color: '#1f1f1f' },
  scolumn: { layer: VIEW_LAYERS.sCutPatt, color: '#1f1f1f' },
  beam: { layer: VIEW_LAYERS.sCutPatt, color: '#1f1f1f' },
  foundation: { layer: VIEW_LAYERS.sCutPatt, color: '#1f1f1f' },
};

/** Cut outline pen (paper mm) per class. */
const CUT_WEIGHT: Partial<Record<PartClass, number>> = {
  door: 0.25, window: 0.25, glass: 0.13, railing: 0.25, curtain: 0.25, equipment: 0.25, ceiling: 0.25,
};

/** Classes whose cut pieces merge into one outline (a wall run reads as one poché). */
const MERGE_GROUP: Partial<Record<PartClass, string>> = {
  wall: 'wall', swall: 'swall', slab: 'slab', sslab: 'sslab', roof: 'roof', stair: 'stair',
  column: 'column', scolumn: 'scolumn', beam: 'beam', foundation: 'foundation',
};

// ─── View definition ────────────────────────────────────────────────────────

/** Elevation directions: the reserved `view_id` values of the derived elevations. */
export const ELEVATION_VIEW_IDS: readonly ElevationDir[] = ['north', 'south', 'east', 'west'];

export interface ViewRef { kind: 'section' | 'elevation'; id: string }

export function viewRefOf(view: OpenView): ViewRef {
  return view.kind === 'elevation' ? { kind: 'elevation', id: view.dir } : { kind: 'section', id: view.id };
}

export function openViewOf(ref: ViewRef): OpenView {
  return ref.kind === 'elevation' ? { kind: 'elevation', dir: ref.id as ElevationDir } : { kind: 'section', id: ref.id };
}

/** `view_id` value → view (sections from global/view.csv, elevations by direction). */
export function resolveViewId(viewId: string, sections: SectionDef[]): ViewRef | null {
  if ((ELEVATION_VIEW_IDS as readonly string[]).includes(viewId)) return { kind: 'elevation', id: viewId };
  return sections.some(s => s.id === viewId) ? { kind: 'section', id: viewId } : null;
}

// ─── Source (model meshes, collected once per project state) ────────────────

export interface ViewSource {
  project: ProjectData;
  grids: GridData[];
  unit: ProjectUnit;
  upm: number;
  parts: ViewPart[];
  /** Global annotation rows (dimension / text_note) that live on a view. */
  annotations: CanonicalElement[];
}

export interface ViewSourceInput extends ViewModelInput { grids?: GridData[] }

/** Dimensions / text notes drawn on sections and elevations (global/, `view_id` set). */
export function viewAnnotationElements(project: ProjectData): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  for (const layer of project.viewAnnotations ?? []) {
    for (const el of parseLayer(layer)) if (el.attrs.view_id) out.push(el);
  }
  return out;
}

export function collectViewSource(input: ViewSourceInput): ViewSource {
  const unit = getProjectUnits({ project: input.project });
  return {
    project: input.project, grids: input.grids ?? [], unit, upm: unitsPerMetre(unit),
    parts: collectViewParts(input),
    annotations: viewAnnotationElements(input.project),
  };
}

// ─── Geometry kernels ───────────────────────────────────────────────────────

/** Point in view space: u (screen x), v (elevation), d (depth along the view). */
interface VP { u: number; v: number; d: number }

interface Basis { dir: P2; right: P2 }

const toView = (b: Basis, x: number, y: number, z: number): VP => ({
  u: x * b.right.x + y * b.right.y, v: z, d: x * b.dir.x + y * b.dir.y,
});

/** Linear half-space in view coordinates: keeps a·u + b·d + c >= 0. */
interface Half { a: number; b: number; c: number }

const side = (h: Half, p: VP) => h.a * p.u + h.b * p.d + h.c;

function lerpVP(p: VP, q: VP, t: number): VP {
  return { u: p.u + (q.u - p.u) * t, v: p.v + (q.v - p.v) * t, d: p.d + (q.d - p.d) * t };
}

/** Sutherland–Hodgman clip of a convex polygon against half-spaces. */
function clipPoly(poly: VP[], halves: Half[]): VP[] {
  let out = poly;
  for (const h of halves) {
    if (out.length === 0) break;
    const next: VP[] = [];
    for (let i = 0; i < out.length; i++) {
      const p = out[i], q = out[(i + 1) % out.length];
      const sp = side(h, p), sq = side(h, q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) next.push(lerpVP(p, q, sp / (sp - sq)));
    }
    out = next;
  }
  return out;
}

/** Clip segment to the half-spaces; null when nothing is left. */
function clipSeg(p: VP, q: VP, halves: Half[]): [VP, VP] | null {
  let t0 = 0, t1 = 1;
  for (const h of halves) {
    const sp = side(h, p), sq = side(h, q);
    if (sp < 0 && sq < 0) return null;
    if (sp >= 0 && sq >= 0) continue;
    const t = sp / (sp - sq);
    if (sp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [lerpVP(p, q, t0), lerpVP(p, q, t1)];
}

/** Occluding triangle in view space. */
interface Occ { a: VP; b: VP; c: VP; minU: number; maxU: number; minV: number; maxV: number; minD: number }

class OccluderGrid {
  private readonly cells: Occ[][];
  private readonly n: number;
  private readonly box: Box;
  private readonly cw: number;
  private readonly ch: number;
  private stamp = 0;
  private readonly seen: Map<Occ, number> = new Map();

  constructor(occs: Occ[]) {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const o of occs) {
      minU = Math.min(minU, o.minU); maxU = Math.max(maxU, o.maxU);
      minV = Math.min(minV, o.minV); maxV = Math.max(maxV, o.maxV);
    }
    this.box = occs.length ? { minX: minU, minY: minV, maxX: maxU, maxY: maxV } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    this.n = Math.max(4, Math.min(160, Math.round(Math.sqrt(occs.length) * 0.8)));
    this.cw = Math.max((this.box.maxX - this.box.minX) / this.n, 1e-9);
    this.ch = Math.max((this.box.maxY - this.box.minY) / this.n, 1e-9);
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    for (const o of occs) {
      const [i0, i1, j0, j1] = this.range(o.minU, o.maxU, o.minV, o.maxV);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.n + i].push(o);
    }
  }

  private range(u0: number, u1: number, v0: number, v1: number): [number, number, number, number] {
    const cl = (x: number) => Math.max(0, Math.min(this.n - 1, x));
    return [
      cl(Math.floor((u0 - this.box.minX) / this.cw)), cl(Math.floor((u1 - this.box.minX) / this.cw)),
      cl(Math.floor((v0 - this.box.minY) / this.ch)), cl(Math.floor((v1 - this.box.minY) / this.ch)),
    ];
  }

  /** Occluders whose box overlaps the segment's box. */
  query(u0: number, u1: number, v0: number, v1: number, maxD: number): Occ[] {
    if (u1 < this.box.minX || u0 > this.box.maxX || v1 < this.box.minY || v0 > this.box.maxY) return [];
    const s = ++this.stamp;
    const out: Occ[] = [];
    const [i0, i1, j0, j1] = this.range(u0, u1, v0, v1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const o of this.cells[j * this.n + i]) {
          if (this.seen.get(o) === s) continue;
          this.seen.set(o, s);
          if (o.minD > maxD || o.maxU < u0 || o.minU > u1 || o.maxV < v0 || o.minV > v1) continue;
          out.push(o);
        }
      }
    }
    return out;
  }
}

function makeOcc(a: VP, b: VP, c: VP): Occ | null {
  const area = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
  if (Math.abs(area) < 1e-12) return null;
  // Counter-clockwise in (u, v)
  const [p, q, r] = area > 0 ? [a, b, c] : [a, c, b];
  return {
    a: p, b: q, c: r,
    minU: Math.min(a.u, b.u, c.u), maxU: Math.max(a.u, b.u, c.u),
    minV: Math.min(a.v, b.v, c.v), maxV: Math.max(a.v, b.v, c.v),
    minD: Math.min(a.d, b.d, c.d),
  };
}

/**
 * Hidden parameter intervals of segment p→q (t in [0, 1]) behind `o`.
 * `tol`: inset of the triangle (so lines along its border stay visible),
 * `depthEps`: how far behind the face a point must be to count as hidden.
 */
function hiddenBy(p: VP, q: VP, o: Occ, tol: number, depthEps: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const edges: [VP, VP][] = [[o.a, o.b], [o.b, o.c], [o.c, o.a]];
  for (const [a, b] of edges) {
    const ex = b.u - a.u, ey = b.v - a.v;
    const l = Math.hypot(ex, ey);
    if (l < 1e-14) return null;
    // Signed distance (left = inside) of p(t) from the edge line
    const f0 = (ex * (p.v - a.v) - ey * (p.u - a.u)) / l - tol;
    const f1 = (ex * (q.v - a.v) - ey * (q.u - a.u)) / l - tol;
    if (f0 < 0 && f1 < 0) return null;
    if (f0 >= 0 && f1 >= 0) continue;
    const t = f0 / (f0 - f1);
    if (f0 < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  // Depth of the triangle plane at p(t): barycentric, affine in t
  const det = (o.b.u - o.a.u) * (o.c.v - o.a.v) - (o.c.u - o.a.u) * (o.b.v - o.a.v);
  const planeD = (u: number, v: number) => {
    const l1 = ((u - o.a.u) * (o.c.v - o.a.v) - (o.c.u - o.a.u) * (v - o.a.v)) / det;
    const l2 = ((o.b.u - o.a.u) * (v - o.a.v) - (u - o.a.u) * (o.b.v - o.a.v)) / det;
    return o.a.d + l1 * (o.b.d - o.a.d) + l2 * (o.c.d - o.a.d);
  };
  const at = (t: number) => lerpVP(p, q, t);
  const pa = at(t0), pb = at(t1);
  const g0 = pa.d - planeD(pa.u, pa.v) - depthEps;
  const g1 = pb.d - planeD(pb.u, pb.v) - depthEps;
  if (g0 <= 0 && g1 <= 0) return null;
  if (g0 > 0 && g1 > 0) return [t0, t1];
  const tm = t0 + (t1 - t0) * (g0 / (g0 - g1));
  return g0 > 0 ? [t0, tm] : [tm, t1];
}

function mergeIntervals(iv: [number, number][]): [number, number][] {
  if (iv.length < 2) return iv;
  iv.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [[...iv[0]]];
  for (let i = 1; i < iv.length; i++) {
    const last = out[out.length - 1];
    if (iv[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[i][1]);
    else out.push([...iv[i]]);
  }
  return out;
}

// ─── Cut (section plane) ────────────────────────────────────────────────────

interface Seg2 { a: Point; b: Point }

/**
 * Slice triangles (outward wound, world coordinates) with the plane d = d0:
 * segments in (u, v), oriented by view direction × face normal so the loops
 * of one solid wind one way and a face shared by two pieces cancels out.
 */
function sliceTris(tris: number[], b: Basis, d0: number, out: Seg2[]) {
  const D = { x: b.dir.x, y: b.dir.y };
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const P = [0, 1, 2].map(k => toView(b, tris[i + 3 * k], tris[i + 3 * k + 1], tris[i + 3 * k + 2]));
    const s = P.map(p => p.d - d0);
    if ((s[0] > 0 && s[1] > 0 && s[2] > 0) || (s[0] < 0 && s[1] < 0 && s[2] < 0)) continue;
    const pts: Point[] = [];
    for (let k = 0; k < 3; k++) {
      const p = P[k], q = P[(k + 1) % 3], sp = s[k], sq = s[(k + 1) % 3];
      if ((sp > 0) !== (sq > 0) && sp !== sq) {
        const t = sp / (sp - sq);
        pts.push({ x: p.u + (q.u - p.u) * t, y: p.v + (q.v - p.v) * t });
      }
    }
    if (pts.length < 2) continue;
    // World normal of the triangle
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const e1 = [tris[i + 3] - ax, tris[i + 4] - ay, tris[i + 5] - az];
    const e2 = [tris[i + 6] - ax, tris[i + 7] - ay, tris[i + 8] - az];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    // s = D × n (D horizontal), expressed in (u, v)
    const sx = D.y * n[2], sy = -D.x * n[2], sz = D.x * n[1] - D.y * n[0];
    const su = sx * b.right.x + sy * b.right.y, sv = sz;
    let [p, q] = pts;
    if ((q.x - p.x) * su + (q.y - p.y) * sv < 0) [p, q] = [q, p];
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-9) continue;
    out.push({ a: p, b: q });
  }
}

const qkey = (p: Point, k: number) => `${Math.round(p.x * k)},${Math.round(p.y * k)}`;

/** Drop pairs of opposite segments (shared faces of adjacent pieces), then chain the rest into loops. */
function chainCut(segs: Seg2[], k: number): Point[][] {
  const count = new Map<string, number>();
  const id = (s: Seg2) => `${qkey(s.a, k)}>${qkey(s.b, k)}`;
  for (const s of segs) count.set(id(s), (count.get(id(s)) ?? 0) + 1);
  const keep = segs.filter(s => {
    const rev = `${qkey(s.b, k)}>${qkey(s.a, k)}`;
    const r = count.get(rev) ?? 0;
    if (r > 0) { count.set(rev, r - 1); return false; }
    return true;
  });
  const byStart = new Map<string, Seg2[]>();
  for (const s of keep) {
    const key = qkey(s.a, k);
    const arr = byStart.get(key);
    if (arr) arr.push(s); else byStart.set(key, [s]);
  }
  const used = new Set<Seg2>();
  const loops: Point[][] = [];
  for (const s0 of keep) {
    if (used.has(s0)) continue;
    used.add(s0);
    const pts = [s0.a];
    let cur = s0;
    const startKey = qkey(s0.a, k);
    let closed = false;
    for (let guard = 0; guard < 100000; guard++) {
      const key = qkey(cur.b, k);
      if (key === startKey) { closed = true; break; }
      const next = byStart.get(key)?.find(s => !used.has(s));
      if (!next) break;
      used.add(next);
      pts.push(next.a);
      cur = next;
    }
    if (closed && pts.length >= 3) loops.push(simplify(pts));
  }
  return loops;
}

/** Remove collinear vertices (a mesh slice has one per triangle). */
function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const l = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
    if (l > 0 && Math.abs(cr) / l < 1e-7) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

function pointInRing(p: Point, r: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringArea(r: Point[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return s / 2;
}

/** Clip a ring to the strip x in [x0, x1] (lateral crop of a section). */
function clipRingX(ring: Point[], x0: number, x1: number): Point[] {
  const clip = (pts: Point[], keep: (p: Point) => number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const sp = keep(p), sq = keep(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    return out;
  };
  return clip(clip(ring, p => p.x - x0), p => x1 - p.x);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

export interface ViewRenderOptions {
  /** Draw hidden edges dashed (default off). */
  hidden?: boolean;
  lang?: DrawingLang;
  /** Add the view's annotations (dimensions / text notes). Default true. */
  annotations?: boolean;
}

class Out {
  readonly layers = new Map<string, DrawingLayer>();
  readonly back: DrawItem[] = [];
  readonly mid: DrawItem[] = [];
  readonly front: DrawItem[] = [];
  readonly anno: DrawItem[] = [];
  layer(def: DrawingLayer): string {
    if (!this.layers.has(def.name)) this.layers.set(def.name, def);
    return def.name;
  }
}

/** Section / elevation drawing at 1:`scale`; null when the view doesn't exist. */
export function renderView(src: ViewSource, ref: ViewRef, scale: number, opts: ViewRenderOptions = {}): ViewDrawing | null {
  const sections = src.project.sections ?? [];
  const open = openViewOf(ref);
  const frame = viewFrame(open, sections);
  if (!frame) return null;
  const section = ref.kind === 'section' ? sections.find(s => s.id === ref.id)! : null;
  const lang = opts.lang ?? 'en';
  const pm = paperMm(src.unit, scale);
  const upm = src.upm;
  const basis: Basis = { dir: frame.dir, right: frame.right };
  const d0 = frame.cutDepth;
  const halves: Half[] = [];
  if (d0 != null) halves.push({ a: 0, b: 1, c: -d0 });
  if (section?.depth != null && d0 != null) halves.push({ a: 0, b: -1, c: d0 + section.depth });
  if (frame.crop) {
    halves.push({ a: 1, b: 0, c: -frame.crop[0] });
    halves.push({ a: -1, b: 0, c: frame.crop[1] });
  }
  const out = new Out();
  const dir3 = { x: frame.dir.x, y: frame.dir.y, z: 0 };

  // 1. Cut faces
  const cutLoops: { cls: PartClass; outer: Point[][]; holes: Point[][] }[] = [];
  const occs: Occ[] = [];
  if (d0 != null) {
    const groups = new Map<string, { cls: PartClass; segs: Seg2[] }>();
    for (const part of src.parts) {
      const g = MERGE_GROUP[part.cls] ?? `${part.cls}:${part.id}`;
      let entry = groups.get(g);
      if (!entry) groups.set(g, entry = { cls: part.cls, segs: [] });
      sliceTris(part.tris, basis, d0, entry.segs);
    }
    const k = 1e4 / upm; // 0.1 mm keys
    for (const { cls, segs } of groups.values()) {
      if (!segs.length) continue;
      const loops: Point[][] = [];
      for (let loop of chainCut(segs, k)) {
        if (frame.crop) loop = clipRingX(loop, frame.crop[0], frame.crop[1]);
        if (loop.length >= 3 && Math.abs(ringArea(loop)) > 1e-10) loops.push(loop);
      }
      // A loop inside an odd number of others is a hole
      const outer: Point[][] = [], holes: Point[][] = [];
      for (const loop of loops) {
        const probe = { x: (loop[0].x + loop[1].x) / 2, y: (loop[0].y + loop[1].y) / 2 };
        let depth = 0;
        for (const other of loops) if (other !== loop && pointInRing(probe, other)) depth++;
        (depth % 2 ? holes : outer).push(loop);
      }
      if (outer.length || holes.length) cutLoops.push({ cls, outer, holes });
      for (const ring of outer) {
        const tri = ShapeUtils.triangulateShape(ring.map(p => new Vector2(p.x, p.y)), []);
        for (const [i, j, l] of tri) {
          const o = makeOcc(
            { u: ring[i].x, v: ring[i].y, d: d0 }, { u: ring[j].x, v: ring[j].y, d: d0 }, { u: ring[l].x, v: ring[l].y, d: d0 });
          if (o) occs.push(o);
        }
      }
    }
  }

  // 2. Occluders: model triangles inside the view volume
  for (const part of src.parts) {
    const t = part.tris;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const tri = [0, 1, 2].map(k => toView(basis, t[i + 3 * k], t[i + 3 * k + 1], t[i + 3 * k + 2]));
      const poly = halves.length ? clipPoly(tri, halves) : tri;
      for (let k = 1; k + 1 < poly.length; k++) {
        const o = makeOcc(poly[0], poly[k], poly[k + 1]);
        if (o) occs.push(o);
      }
    }
  }
  const grid = new OccluderGrid(occs);

  // 3. Edges → visible / hidden pieces
  const tol = 1e-5 * upm, depthEps = 2e-3 * upm;
  const beyondLayer = out.layer(ref.kind === 'section' ? VIEW_LAYERS.beyond : VIEW_LAYERS.elev);
  const glassLayer = out.layer(VIEW_LAYERS.glass);
  const hiddenLayer = opts.hidden ? out.layer(VIEW_LAYERS.hidden) : '';
  const seen = new Set<string>();
  const dk = 1e4 / upm;
  const emitEdge = (part: ViewPart, A: VP, B: VP) => {
    const c = halves.length ? clipSeg(A, B, halves) : [A, B] as [VP, VP];
    if (!c) return;
    const [p, q] = c;
    if (Math.hypot(q.u - p.u, q.v - p.v) < 1e-6 * upm) return; // seen end-on
    const key = [qkey({ x: p.u, y: p.v }, dk), qkey({ x: q.u, y: q.v }, dk)].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const cands = grid.query(Math.min(p.u, q.u), Math.max(p.u, q.u), Math.min(p.v, q.v), Math.max(p.v, q.v), Math.max(p.d, q.d) - depthEps);
    const hidden: [number, number][] = [];
    for (const o of cands) {
      const h = hiddenBy(p, q, o, tol, depthEps);
      if (h) hidden.push(h);
    }
    const merged = mergeIntervals(hidden);
    const pt = (t: number): Point => ({ x: p.u + (q.u - p.u) * t, y: p.v + (q.v - p.v) * t });
    let cursor = 0;
    const layer = part.cls === 'glass' ? glassLayer : beyondLayer;
    const minT = 1e-4;
    for (const [h0, h1] of merged) {
      if (h0 - cursor > minT) out.back.push({ kind: 'path', layer, pts: [pt(cursor), pt(h0)], closed: false });
      if (hiddenLayer && h1 - h0 > minT) out.back.push({ kind: 'path', layer: hiddenLayer, pts: [pt(h0), pt(h1)], closed: false });
      cursor = Math.max(cursor, h1);
    }
    if (1 - cursor > minT) out.back.push({ kind: 'path', layer, pts: [pt(cursor), pt(1)], closed: false });
  };
  for (const part of src.parts) {
    const s = part.sharp;
    for (let i = 0; i + 5 < s.length; i += 6) {
      emitEdge(part, toView(basis, s[i], s[i + 1], s[i + 2]), toView(basis, s[i + 3], s[i + 4], s[i + 5]));
    }
    for (const e of part.smooth) {
      const f1 = e.n1.x * dir3.x + e.n1.y * dir3.y, f2 = e.n2.x * dir3.x + e.n2.y * dir3.y;
      if (f1 * f2 >= 0) continue; // not a silhouette from this side
      emitEdge(part, toView(basis, e.a.x, e.a.y, e.a.z), toView(basis, e.b.x, e.b.y, e.b.z));
    }
  }

  // 4. Poché and cut outlines
  const cutLayer = out.layer(VIEW_LAYERS.cut);
  for (const { cls, outer, holes } of cutLoops) {
    const fill = CUT_FILL[cls];
    if (fill) {
      const fl = out.layer(fill.layer);
      for (const ring of outer) out.mid.push({ kind: 'path', layer: fl, pts: ring, closed: true, fill: fill.color, noStroke: true });
      for (const ring of holes) out.mid.push({ kind: 'path', layer: fl, pts: ring, closed: true, fill: '#ffffff', noStroke: true, dxfOnly: false });
    } else {
      // Outline-only cuts (frames, glass, railings) mask what's behind them
      for (const ring of outer) out.mid.push({ kind: 'path', layer: cutLayer, pts: ring, closed: true, fill: '#ffffff', noStroke: true });
    }
    const weight = CUT_WEIGHT[cls];
    for (const ring of [...outer, ...holes]) {
      out.front.push({ kind: 'path', layer: cutLayer, pts: ring, closed: true, ...(weight ? { weight } : {}) });
    }
  }

  // Model extent (u, v) for datums
  const model = itemsBounds([...out.back, ...out.front]);
  const ext: Box = model ?? { minX: frame.crop?.[0] ?? 0, maxX: frame.crop?.[1] ?? 10 * upm, minY: 0, maxY: 3 * upm };
  if (frame.crop) { ext.minX = Math.min(ext.minX, frame.crop[0]); ext.maxX = Math.max(ext.maxX, frame.crop[1]); }

  // 5. Ground line, levels, grids
  const levels = levelLines(src.project.levels);
  const ground = levels.length ? levels[0].elevation : ext.minY;
  const over = 6 * pm;
  out.front.push({ kind: 'path', layer: out.layer(VIEW_LAYERS.ground), pts: [{ x: ext.minX - over, y: ground }, { x: ext.maxX + over, y: ground }], closed: false });

  const levelLayer = out.layer(VIEW_LAYERS.level), levelId = out.layer(VIEW_LAYERS.levelId);
  const x0 = ext.minX - over, xe = ext.maxX + 10 * pm;
  const unitSuffix = src.unit === 'm' ? '' : ` ${src.unit}`;
  for (const lv of levels) {
    const z = lv.elevation;
    out.anno.push({ kind: 'path', layer: levelLayer, pts: [{ x: x0, y: z }, { x: xe, y: z }], closed: false });
    // Head: datum triangle on the line, shoulder line, elevation over it, name under it
    const w = 1.6 * pm, h = 2.2 * pm;
    out.anno.push({ kind: 'path', layer: levelId, pts: [{ x: xe, y: z }, { x: xe - w, y: z + h }, { x: xe + w, y: z + h }], closed: true });
    out.anno.push({ kind: 'path', layer: levelId, pts: [{ x: xe + w, y: z + h }, { x: xe + 16 * pm, y: z + h }], closed: false });
    const elevText = formatElevation(z, src.unit) + unitSuffix;
    out.anno.push({ kind: 'text', layer: levelId, at: { x: xe + 1.2 * pm, y: z + h + 0.9 * pm }, text: elevText, height: 2.2 * pm, align: 'left', valign: 'baseline' });
    out.anno.push({ kind: 'text', layer: levelId, at: { x: xe + 1.2 * pm, y: z - 3 * pm }, text: lv.name, height: 2.0 * pm, align: 'left', valign: 'baseline' });
  }

  const marks = gridMarks(src.grids, frame, d0 ?? frontDepth(src, basis));
  if (marks.length) {
    const gl = out.layer(LAYERS.grid), gi = out.layer(LAYERS.gridIden);
    const top = Math.max(ext.maxY, levels.length ? levels[levels.length - 1].elevation : ext.maxY) + 6 * pm;
    const bottom = Math.min(ext.minY, ground) - 3 * pm;
    const r = 4.5 * pm;
    for (const m of marks) {
      if (frame.crop && (m.at < frame.crop[0] - 1e-6 || m.at > frame.crop[1] + 1e-6)) continue;
      out.anno.push({ kind: 'path', layer: gl, pts: [{ x: m.at, y: bottom }, { x: m.at, y: top }], closed: false });
      const c = { x: m.at, y: top + r };
      out.anno.push({ kind: 'circle', layer: gi, center: c, radius: r, fill: '#ffffff' });
      if (m.number) out.anno.push({ kind: 'text', layer: gi, at: c, text: m.number, height: 3.2 * pm, align: 'center', valign: 'middle', bold: true });
    }
  }

  // 6. The view's annotations
  if (opts.annotations !== false) {
    const own = src.annotations.filter(a => a.attrs.view_id === ref.id);
    if (own.length) {
      for (const it of annotationItems(own, src.unit, scale, def => out.layer(def))) out.anno.push(it);
    }
  }

  const items = [...out.back, ...out.mid, ...out.front, ...out.anno];
  const title = ref.kind === 'elevation'
    ? drawingLabel(lang, 'views.elevationOf', { dir: drawingLabel(lang, `views.dir.${ref.id}`) })
    : drawingLabel(lang, 'views.sectionOf', { name: section?.name || ref.id });
  return {
    kind: ref.kind, viewId: ref.id, title,
    unit: src.unit, scale, pm, items, layers: out.layers,
    bounds: itemsBounds(items), legend: [],
  };
}

/** Elevations: depth of the model's front (grids are measured there). */
function frontDepth(src: ViewSource, b: Basis): number {
  let min = Infinity;
  for (const p of src.parts) {
    for (let i = 0; i + 2 < p.tris.length; i += 3) min = Math.min(min, p.tris[i] * b.dir.x + p.tris[i + 1] * b.dir.y);
  }
  return Number.isFinite(min) ? min : 0;
}

/** Elevation label value in metres for metric projects ("+4.000"), else the project unit. */
function formatElevation(v: number, unit: ProjectUnit): string {
  if (unit === 'm') return formatLevelElevation(v);
  if (unit === 'mm') return (v > 0 ? '+' : '') + Math.round(v);
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

/** Convenience: collect + render one view. */
export function buildViewDrawing(input: ViewSourceInput, ref: ViewRef, scale: number, opts?: ViewRenderOptions): ViewDrawing | null {
  return renderView(collectViewSource(input), ref, scale, opts);
}
