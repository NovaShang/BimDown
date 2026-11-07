/**
 * Floor plan drawing model: turns one level of a project into backend-neutral
 * draw items (model coordinates, Y up) with architectural plan graphics — wall
 * poché, door swings, window symbols, stairs cut at the plan height with a
 * direction arrow, room tags with areas, grids with bubbles, structure and MEP.
 * `exportPdf` lays the items out on a sheet, `exportDxf` writes them as CAD
 * entities on AIA-style layers.
 *
 * Geometry comes from the element modules (`geometry()`), so walls miter and
 * split at openings exactly as in the editor and rooms use the same derived
 * boundaries. Sizes that belong to the paper (text, bubbles, arrows) are given
 * in millimetres and converted with `pm` (model units per paper mm).
 */
import '../../elements/registerAll.ts';
import type { ProjectData, GridData, Level, ProjectUnit } from '../../types.ts';
import type { CanonicalElement, LineElement, Point } from '../../model/elements.ts';
import { parseFloorLayers, parseLayer } from '../../model/parse.ts';
import { getElementModule } from '../../elements/registry.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import { buildGeometryContext } from '../../adapters/svg/buildContext.ts';
import { gridsToElements } from '../../utils/gridBridge.ts';
import { getProjectUnits } from '../../utils/units.ts';
import { resolveMepSystemColor } from '../../elements/_mepLineShared.tsx';
import type { LineWallFacts } from '../../elements/_lineWallShared.tsx';
import type { MepLineFacts } from '../../elements/_mepLineShared.tsx';
import type { DoorFacts } from '../../elements/door.tsx';
import type { WindowFacts } from '../../elements/window.tsx';
import type { ColumnFacts } from '../../elements/column.tsx';
import type { StairFacts } from '../../elements/stair.tsx';
import type { RampFacts } from '../../elements/ramp.tsx';
import type { SpaceFacts } from '../../elements/space.tsx';
import type { CurtainWallFacts } from '../../elements/curtain_wall.tsx';
import type { BeamFacts } from '../../elements/beam.tsx';
import type { FoundationFacts } from '../../elements/foundation.tsx';
import type { EquipmentFacts } from '../../elements/equipment.tsx';
import type { MepNodeFacts } from '../../elements/mep_node.tsx';
import { LAYERS, mepLayer, type DrawingLayer } from './layers.ts';
import { tint } from './color.ts';
import { registeredPlanAnnotators, type PlanAnnotator } from './annotations.ts';
import { drawingLabel, type DrawingLang } from './labels.ts';
import type { Box, DrawItem, DrawingDiscipline, LegendEntry, PlanDrawing } from './types.ts';

export interface PlanInput {
  project: ProjectData;
  levelId: string;
  /** Project grids (`state.grids`; they live outside ProjectData). */
  grids?: GridData[];
  discipline?: DrawingDiscipline;
  lang?: DrawingLang;
  /** Defaults to the registered annotators. */
  annotators?: readonly PlanAnnotator[];
}

/** Model units per metre. */
export function unitsPerMetre(unit: ProjectUnit): number {
  switch (unit) {
    case 'mm': return 1000;
    case 'ft': return 1 / 0.3048;
    case 'in': return 1 / 0.0254;
    default: return 1;
  }
}

/** Model units per paper millimetre at 1:`scale`. */
export function paperMm(unit: ProjectUnit, scale: number): number {
  return (scale / 1000) * unitsPerMetre(unit);
}

/** Plan cut height above the floor (m), as in Revit's default view range. */
const CUT_HEIGHT_M = 1.2;

// ─── Collected level (geometry computed once, emitted per scale) ────────────

interface Entry { el: CanonicalElement; facts: unknown }

export interface PlanSource {
  input: PlanInput;
  level: Level;
  unit: ProjectUnit;
  upm: number;
  discipline: DrawingDiscipline;
  lang: DrawingLang;
  ctx: GeometryContext;
  entries: Entry[];
  byId: Map<string, CanonicalElement>;
  factsCache: Map<string, unknown>;
}

/** Parse a level and run the element modules' geometry. Null when the level doesn't exist. */
export function collectPlan(input: PlanInput): PlanSource | null {
  const { project } = input;
  const level = project.levels.find(l => l.id === input.levelId);
  if (!level) return null;
  const floor = project.floors.get(level.id);
  const elements: CanonicalElement[] = floor ? parseFloorLayers(floor.layers) : [];
  for (const gl of project.globalLayers) {
    for (const el of parseLayer(gl)) elements.push({ ...el, id: `global:${el.id}` });
  }
  elements.push(...gridsToElements(input.grids ?? []));

  const byId = new Map<string, CanonicalElement>();
  for (const el of elements) byId.set(el.id, el);
  const ctx = buildGeometryContext({ level, allLevels: project.levels, allElements: byId, mepSystems: project.mepSystems });
  const factsCache = new Map<string, unknown>();
  const entries: Entry[] = [];
  for (const el of elements) {
    const mod = getElementModule(el.tableName);
    let facts: unknown = null;
    try { facts = mod ? mod.geometry(el, ctx) : null; } catch { facts = null; }
    factsCache.set(el.id, facts);
    if (facts) entries.push({ el, facts });
  }
  const unit = getProjectUnits({ project });
  return {
    input, level, unit, upm: unitsPerMetre(unit),
    discipline: input.discipline ?? 'all',
    lang: input.lang ?? 'en',
    ctx, entries, byId, factsCache,
  };
}

// ─── Visibility per discipline ──────────────────────────────────────────────

type Role = 'full' | 'halftone' | 'hidden';

const ALWAYS_HIDDEN = new Set(['connector', 'mesh', 'ceiling']);
const STRUCTURE_CUT = new Set(['structure_wall', 'structure_column', 'structure_slab']);
const STRUCTURE_BELOW_ABOVE = new Set(['beam', 'brace', 'foundation']);

function roleOf(table: string, discipline: string, view: DrawingDiscipline): Role {
  if (ALWAYS_HIDDEN.has(table)) return 'hidden';
  if (table === 'grid') return 'full';
  if (view === 'all') return 'full';
  if (discipline === 'mep') return view === 'mep' ? 'full' : 'hidden';
  if (view === 'architecture') {
    if (discipline === 'architecture') return 'full';
    if (STRUCTURE_CUT.has(table)) return 'full';
    return 'hidden';
  }
  if (view === 'structure') {
    if (discipline === 'structure') return 'full';
    return discipline === 'architecture' ? 'halftone' : 'hidden';
  }
  // MEP view: building as faded context, no beams or footings
  if (STRUCTURE_BELOW_ABOVE.has(table)) return 'hidden';
  return 'halftone';
}

// ─── Small geometry helpers ─────────────────────────────────────────────────

const add = (p: Point, v: Point, t = 1): Point => ({ x: p.x + v.x * t, y: p.y + v.y * t });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Point) => Math.hypot(v.x, v.y);
const unit = (v: Point): Point => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l }; };
const perp = (v: Point): Point => ({ x: -v.y, y: v.x });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const near = (a: Point, b: Point, eps: number) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

function rotateAbout(pts: Point[], c: Point, deg: number): Point[] {
  if (!deg) return pts.map(p => ({ x: c.x + p.x, y: c.y + p.y }));
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return pts.map(p => ({ x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos }));
}

function rectAt(c: Point, w: number, d: number, deg: number): Point[] {
  return rotateAbout([
    { x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, { x: w / 2, y: d / 2 }, { x: -w / 2, y: d / 2 },
  ], c, deg);
}

function polygonArea(v: Point[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Join edges that share endpoints into polylines (wall outlines read as continuous lines in CAD). */
export function chainEdges(edges: [Point, Point][], eps: number): Point[][] {
  const out: Point[][] = [];
  for (const [a, b] of edges) {
    const last = out[out.length - 1];
    if (last && near(last[last.length - 1], a, eps)) last.push(b);
    else out.push([a, b]);
  }
  return out;
}

/** Clip segment a→b to a box (Liang–Barsky); null when outside. */
function clipSegment(a: Point, b: Point, box: Box): [Point, Point] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [lerp(a, b, t0), lerp(a, b, t1)];
}

/** Rough text extent for bounds (the PDF writer measures real glyphs). */
export function approxTextWidth(text: string, height: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? 1.38 : 0.75;
  return w * height;
}

// ─── Emission ───────────────────────────────────────────────────────────────

/** Paint order: earlier phases are drawn first (below). */
const Phase = {
  GridLine: 0, Below: 1, Floor: 2, Mep: 3, Cut: 4, Openings: 5, MepOnTop: 6, Above: 7, GridBubble: 8, Tags: 9, Annotation: 10,
} as const;
type Phase = (typeof Phase)[keyof typeof Phase];

class Emitter {
  readonly phases: DrawItem[][] = Array.from({ length: Phase.Annotation + 1 }, () => []);
  readonly layers = new Map<string, DrawingLayer>();
  phase: Phase = Phase.Floor;
  halftone = false;

  layer(def: DrawingLayer): string {
    if (!this.layers.has(def.name)) this.layers.set(def.name, def);
    return def.name;
  }

  push(item: DrawItem) {
    if (this.halftone) item.halftone = true;
    this.phases[this.phase].push(item);
  }

  line(def: DrawingLayer, a: Point, b: Point, extra: Partial<DrawItem> = {}) {
    this.push({ kind: 'path', layer: this.layer(def), pts: [a, b], closed: false, ...extra } as DrawItem);
  }

  poly(def: DrawingLayer, pts: Point[], closed: boolean, extra: Partial<DrawItem> = {}) {
    if (pts.length < 2) return;
    this.push({ kind: 'path', layer: this.layer(def), pts, closed, ...extra } as DrawItem);
  }

  /** Solid fill (poché) without outline. */
  fill(def: DrawingLayer, pts: Point[], color = def.color) {
    if (pts.length < 3) return;
    this.push({ kind: 'path', layer: this.layer(def), pts, closed: true, fill: color, noStroke: true });
  }

  text(def: DrawingLayer, at: Point, text: string, height: number, extra: Partial<Extract<DrawItem, { kind: 'text' }>> = {}) {
    if (!text) return;
    this.push({ kind: 'text', layer: this.layer(def), at, text, height, align: 'center', valign: 'middle', ...extra });
  }

  items(): DrawItem[] { return this.phases.flat(); }
}

// ─── Per-element plan graphics ──────────────────────────────────────────────

interface DrawEnv {
  src: PlanSource;
  e: Emitter;
  /** Model units per paper mm. */
  pm: number;
  legend: Map<string, LegendEntry>;
}

function hostThickness(env: DrawEnv, el: CanonicalElement, fallback: number): number {
  const host = el.hostId ? env.src.byId.get(el.hostId) : undefined;
  return host && host.geometry === 'line' ? (host as LineElement).strokeWidth || fallback : fallback;
}

function drawWall(env: DrawEnv, f: LineWallFacts) {
  const structural = f.table === 'structure_wall';
  const patt = structural ? LAYERS.sWallPatt : LAYERS.wallPatt;
  const outline = structural ? LAYERS.sWall : LAYERS.wall;
  env.e.phase = Phase.Cut;
  for (const seg of f.segments) env.e.fill(patt, seg.corners);
  const edges = f.segments.flatMap(s => s.outline);
  for (const pts of chainEdges(edges, 1e-6 * env.src.upm)) env.e.poly(outline, pts, false);
}

/** Wall-hosted opening without a door/window: show the wall above as hidden lines. */
function drawWallOpening(env: DrawEnv, el: LineElement) {
  const t = hostThickness(env, el, 0.2 * env.src.upm);
  const dir = sub(el.end, el.start);
  if (len(dir) < 1e-9) return;
  const n = perp(unit(dir));
  env.e.phase = Phase.Openings;
  env.e.line(LAYERS.wallAbove, add(el.start, n, t / 2), add(el.end, n, t / 2));
  env.e.line(LAYERS.wallAbove, add(el.start, n, -t / 2), add(el.end, n, -t / 2));
}

function drawDoor(env: DrawEnv, el: LineElement, f: DoorFacts) {
  const { e, pm } = env;
  const t = hostThickness(env, el, 0.2 * env.src.upm);
  const u = unit(sub(f.end, f.start));
  const side = f.swingRight ? -1 : 1;
  const n = perp(u);
  const leafN = { x: n.x * side, y: n.y * side };
  const W = f.length;
  const leafT = Math.min(0.04 * env.src.upm, W * 0.06, Math.max(0.5 * pm, 0.02 * env.src.upm));
  e.phase = Phase.Openings;

  /** One swing leaf hinged at `hinge` (on the centreline), closing towards `toward`. */
  const swingLeaf = (hinge: Point, toward: Point, width: number) => {
    const h = add(hinge, leafN, t / 2);
    const tip = add(h, leafN, width);
    const a = unit(sub(toward, hinge));
    e.poly(LAYERS.door, [h, tip, add(tip, a, leafT), add(h, a, leafT)], true);
    const angA = Math.atan2(a.y, a.x), angN = Math.atan2(leafN.y, leafN.x);
    const ccw = a.x * leafN.y - a.y * leafN.x > 0;
    e.push({ kind: 'arc', layer: e.layer(LAYERS.doorSwing), center: h, radius: width,
      start: ccw ? angA : angN, end: ccw ? angN : angA });
  };

  switch (f.operation) {
    case 'double_swing':
      swingLeaf(f.start, f.end, W / 2);
      swingLeaf(f.end, f.start, W / 2);
      break;
    case 'sliding': {
      const p = W * 0.55, off = t / 6;
      const panel = (a: Point, b: Point, o: number) => {
        const a1 = add(a, n, o - leafT / 2), b1 = add(b, n, o - leafT / 2);
        e.poly(LAYERS.door, [a1, b1, add(b1, n, leafT), add(a1, n, leafT)], true);
      };
      panel(f.start, add(f.start, u, p), off);
      panel(add(f.end, u, -p), f.end, -off);
      break;
    }
    case 'folding': {
      const k = 4, depth = W / (2 * k);
      const pts: Point[] = [];
      for (let i = 0; i <= k; i++) pts.push(add(add(f.start, u, (W * i) / k), leafN, t / 2 + (i % 2 ? depth : 0)));
      e.poly(LAYERS.door, pts, false);
      break;
    }
    case 'revolving': {
      const c = lerp(f.start, f.end, 0.5);
      e.push({ kind: 'circle', layer: e.layer(LAYERS.doorSwing), center: c, radius: W / 2 });
      for (const deg of [45, 135]) {
        const r = (deg * Math.PI) / 180 + Math.atan2(u.y, u.x);
        const v = { x: Math.cos(r) * W / 2, y: Math.sin(r) * W / 2 };
        e.line(LAYERS.door, add(c, v, -1), add(c, v));
      }
      break;
    }
    default: {
      const hinge = f.hingeEnd ? f.end : f.start;
      const other = f.hingeEnd ? f.start : f.end;
      swingLeaf(hinge, other, W);
    }
  }
}

function drawWindow(env: DrawEnv, el: LineElement, f: WindowFacts) {
  const { e } = env;
  const t = hostThickness(env, el, f.strokeWidth || 0.2 * env.src.upm);
  const u = unit(sub(f.end, f.start));
  const n = perp(u);
  const at = (p: Point, o: number) => add(p, n, o);
  e.phase = Phase.Openings;
  e.poly(LAYERS.window, [at(f.start, t / 2), at(f.end, t / 2), at(f.end, -t / 2), at(f.start, -t / 2)], true);
  if (f.operation === 'sliding') {
    const mid = lerp(f.start, f.end, 0.5), ov = f.length * 0.05;
    e.line(LAYERS.window, at(f.start, t / 8), at(add(mid, u, ov), t / 8));
    e.line(LAYERS.window, at(add(mid, u, -ov), -t / 8), at(f.end, -t / 8));
  } else {
    e.line(LAYERS.window, at(f.start, t / 6), at(f.end, t / 6));
    e.line(LAYERS.window, at(f.start, -t / 6), at(f.end, -t / 6));
  }
}

function drawCurtainWall(env: DrawEnv, f: CurtainWallFacts) {
  const { e } = env;
  e.phase = Phase.Cut;
  e.poly(LAYERS.curtainWall, f.footprint2D, true);
  const u = unit(sub(f.end, f.start));
  const n = perp(u);
  const half = Math.max(len(sub(f.footprint2D[0], f.footprint2D[3])) / 2, 0.6 * env.pm);
  e.line(LAYERS.curtainWall, f.start, f.end, { weight: 0.13 });
  for (let i = 0; i <= f.uGridCount; i++) {
    const c = add(f.start, u, (f.length * i) / Math.max(1, f.uGridCount));
    e.line(LAYERS.curtainWall, add(c, n, -half * 1.6), add(c, n, half * 1.6));
  }
}

function drawColumn(env: DrawEnv, f: ColumnFacts, table: string) {
  const { e } = env;
  const structural = table === 'structure_column';
  const patt = structural ? LAYERS.sColumnPatt : LAYERS.columnPatt;
  const outline = structural ? LAYERS.sColumn : LAYERS.column;
  e.phase = Phase.Cut;
  const { family, params } = f.section;
  const bb = family.bbox(params);
  if (family.id === 'round' && Math.abs(bb.w - bb.d) < 1e-9) {
    e.push({ kind: 'circle', layer: e.layer(patt), center: f.position, radius: bb.w / 2, fill: patt.color, noStroke: true });
    e.push({ kind: 'circle', layer: e.layer(outline), center: f.position, radius: bb.w / 2 });
    return;
  }
  let local: Point[];
  if (family.id === 'round') {
    local = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return { x: (Math.cos(a) * bb.w) / 2, y: (Math.sin(a) * bb.d) / 2 };
    });
  } else if (family.id === 'rect') {
    local = [{ x: -bb.w / 2, y: -bb.d / 2 }, { x: bb.w / 2, y: -bb.d / 2 }, { x: bb.w / 2, y: bb.d / 2 }, { x: -bb.w / 2, y: bb.d / 2 }];
  } else {
    local = family.outline2D(params);
  }
  const pts = rotateAbout(local, f.position, f.rotationDeg);
  e.fill(patt, pts);
  e.poly(outline, pts, true);
}

function drawStair(env: DrawEnv, f: StairFacts) {
  const { e, pm, src } = env;
  e.phase = Phase.Floor;
  const u = unit(sub(f.end, f.start));
  const n = perp(u);
  const hw = f.width / 2;
  const at = (t: number, o: number) => add(add(f.start, u, f.horLen * t), n, o);
  const goingUp = f.endZ > f.startZ;
  const cutZ = CUT_HEIGHT_M * src.upm;
  // Fraction of the run below the cut plane; the rest is above (hidden)
  const cut = goingUp && f.endZ - f.startZ > 1e-9
    ? Math.max(0, Math.min(1, (cutZ - f.startZ) / (f.endZ - f.startZ)))
    : 1;
  const below = LAYERS.stair, above = LAYERS.stairAbove;
  // Stringers
  for (const o of [hw, -hw]) {
    if (cut > 0) e.line(below, at(0, o), at(cut, o));
    if (cut < 1) e.line(above, at(cut, o), at(1, o));
  }
  e.line(below, at(0, hw), at(0, -hw));
  e.line(cut < 1 ? above : below, at(1, hw), at(1, -hw));
  // Treads
  for (let i = 1; i < f.stepCount; i++) {
    const t = i / f.stepCount;
    e.line(t <= cut ? below : above, at(t, hw), at(t, -hw));
  }
  // Break line across the run at the cut plane
  if (cut > 0 && cut < 1) {
    const z = Math.min(f.horLen * 0.06, 2.5 * pm) / f.horLen;
    e.poly(below, [at(cut - z, hw), at(cut - z / 4, hw * 0.1), at(cut + z / 4, -hw * 0.1), at(cut + z, -hw)], false, { weight: 0.25 });
  }
  // Walking line from the start (dot) to an arrow head at the far end
  const head = Math.min(2.2 * pm, f.width * 0.35);
  const t0 = Math.min(0.08, (1.2 * pm) / f.horLen), t1 = 1 - Math.min(0.04, (0.6 * pm) / f.horLen);
  const tip = at(t1, 0);
  const back = add(tip, u, -head);
  e.line(below, at(t0, 0), back);
  e.push({ kind: 'path', layer: e.layer(below), pts: [tip, add(back, n, head * 0.35), add(back, n, -head * 0.35)], closed: true, fill: below.color });
  e.push({ kind: 'circle', layer: e.layer(below), center: at(t0, 0), radius: 0.7 * pm, fill: below.color, noStroke: true });
  // UP / DN beside the start of the walking line, reading upright
  e.phase = Phase.Tags;
  const label = drawingLabel(src.lang, goingUp ? 'drawing.up' : 'drawing.down');
  const labelAt = add(at(Math.min(0.35, t0 + (3.5 * pm) / f.horLen), 0), n, Math.min(hw * 0.5, 2 * pm));
  e.text(LAYERS.areaIden, labelAt, label, 1.8 * pm, { bold: true, rotation: uprightAngle(u) });
}

/** Direction angle of `u`, flipped by 180° when text along it would read upside down. */
function uprightAngle(u: Point): number {
  let a = Math.atan2(u.y, u.x);
  if (a > Math.PI / 2 + 1e-9) a -= Math.PI;
  else if (a < -Math.PI / 2 - 1e-9) a += Math.PI;
  return a;
}

function drawRamp(env: DrawEnv, f: RampFacts) {
  const { e, pm } = env;
  e.phase = Phase.Floor;
  e.poly(LAYERS.stair, f.footprint2D, true);
  const lowToHigh = f.endZ >= f.startZ;
  const a = lowToHigh ? f.start : f.end, b = lowToHigh ? f.end : f.start;
  const u = unit(sub(b, a));
  const n = perp(u);
  const head = Math.min(2.2 * pm, f.width * 0.35);
  const tip = add(b, u, -Math.min(1.5 * pm, f.length * 0.05));
  const back = add(tip, u, -head);
  e.line(LAYERS.stair, add(a, u, Math.min(1.5 * pm, f.length * 0.05)), back);
  e.push({ kind: 'path', layer: e.layer(LAYERS.stair), pts: [tip, add(back, n, head * 0.35), add(back, n, -head * 0.35)], closed: true, fill: LAYERS.stair.color });
  if (f.length > 1e-9) {
    const pct = (Math.abs(f.endZ - f.startZ) / f.length) * 100;
    e.phase = Phase.Tags;
    const mid = add(lerp(f.start, f.end, 0.5), n, 1.6 * pm);
    e.text(LAYERS.areaIden, mid, `${pct.toFixed(1)}%`, 1.8 * pm, { rotation: uprightAngle(u) });
  }
}

/** Area in the unit people quote: m² for metric projects, ft² for imperial. */
export function formatArea(areaModel: number, unitName: ProjectUnit): string {
  switch (unitName) {
    case 'mm': return `${(areaModel / 1e6).toFixed(2)} m²`;
    case 'ft': return `${areaModel.toFixed(1)} ft²`;
    case 'in': return `${(areaModel / 144).toFixed(1)} ft²`;
    default: return `${areaModel.toFixed(2)} m²`;
  }
}

const BOUNDING = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);

/**
 * Room outline at the wall faces. Derived boundaries run along wall centre
 * lines; plans quote the net (usable) area, so each edge moves inwards by half
 * the thickness of the wall it lies on (0 for room separators / unmatched).
 */
export function netRoomPolygon(v: Point[], walls: LineElement[], eps: number): Point[] {
  const n = v.length;
  if (n < 3) return v;
  let signed = 0;
  for (let i = 0; i < n; i++) signed += v[i].x * v[(i + 1) % n].y - v[(i + 1) % n].x * v[i].y;
  const ccw = signed > 0;
  const lines = v.map((a, i) => {
    const b = v[(i + 1) % n];
    const d = unit(sub(b, a));
    const inward = ccw ? perp(d) : { x: -perp(d).x, y: -perp(d).y };
    const mid = lerp(a, b, 0.5);
    let half = 0;
    for (const w of walls) {
      if (w.arc) continue;
      const wd = sub(w.end, w.start), wl = len(wd);
      if (wl < eps) continue;
      const wu = { x: wd.x / wl, y: wd.y / wl };
      const off = (p: Point) => Math.abs((p.x - w.start.x) * wu.y - (p.y - w.start.y) * wu.x);
      if (off(a) > eps || off(b) > eps) continue;
      const t = (mid.x - w.start.x) * wu.x + (mid.y - w.start.y) * wu.y;
      if (t < -eps || t > wl + eps) continue;
      half = w.tableName === 'room_separator' ? 0 : w.strokeWidth / 2;
      break;
    }
    return { p: add(a, inward, half), d };
  });
  return lines.map((cur, i) => {
    const prev = lines[(i + n - 1) % n];
    const den = prev.d.x * cur.d.y - prev.d.y * cur.d.x;
    if (Math.abs(den) < 1e-12) return cur.p;
    const t = ((cur.p.x - prev.p.x) * cur.d.y - (cur.p.y - prev.p.y) * cur.d.x) / den;
    return add(prev.p, prev.d, t);
  });
}

/** Width of the polygon along the horizontal line through `p` (the inside span containing p). */
function spanAt(v: Point[], p: Point): number | null {
  const xs: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    if ((a.y <= p.y && b.y > p.y) || (b.y <= p.y && a.y > p.y)) xs.push(a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  xs.sort((x, y) => x - y);
  for (let i = 0; i + 1 < xs.length; i += 2) if (p.x >= xs[i] && p.x <= xs[i + 1]) return xs[i + 1] - xs[i];
  return null;
}

function drawSpace(env: DrawEnv, f: SpaceFacts) {
  const { e, pm, src } = env;
  if (f.kind === 'polygon' && f.vertices) {
    e.phase = Phase.Below;
    e.poly(LAYERS.area, f.vertices, true, { dxfOnly: true });
  }
  const lines: { text: string; h: number; bold?: boolean }[] = [];
  if (f.name) lines.push({ text: f.name, h: 2.5 * pm, bold: true });
  if (f.number) lines.push({ text: f.number, h: 2.0 * pm });
  if (f.kind === 'polygon' && f.vertices && (f.name || f.number)) {
    const walls = src.entries.filter(x => BOUNDING.has(x.el.tableName) && x.el.geometry === 'line').map(x => x.el as LineElement);
    lines.push({ text: formatArea(polygonArea(netRoomPolygon(f.vertices, walls, 1e-4 * src.upm)), src.unit), h: 1.8 * pm });
  }
  if (lines.length === 0) return;
  e.phase = Phase.Tags;
  // Shrink the tag (down to 60 %) to fit the room's width at the label
  const room = f.kind === 'polygon' && f.vertices ? spanAt(f.vertices, f.anchor) : null;
  if (room) {
    const widest = Math.max(...lines.map(l => approxTextWidth(l.text, l.h) * (l.bold ? 1.1 : 1)));
    const k = Math.max(0.6, Math.min(1, (room * 0.9) / widest));
    for (const l of lines) l.h *= k;
  }
  const gap = 1.1 * pm * (lines[0].h / (lines[0].bold ? 2.5 * pm : 2.0 * pm));
  const total = lines.reduce((s, l) => s + l.h, 0) + gap * (lines.length - 1);
  let y = f.anchor.y + total / 2;
  for (const l of lines) {
    y -= l.h / 2;
    e.text(LAYERS.areaIden, { x: f.anchor.x, y }, l.text, l.h, { bold: l.bold });
    y -= l.h / 2 + gap;
  }
}

function drawFoundation(env: DrawEnv, f: FoundationFacts) {
  const { e } = env;
  e.phase = Phase.Below;
  if (f.kind === 'point') e.poly(LAYERS.sFoundation, rectAt(f.position, f.width, f.depth, f.rotationDeg), true);
  else if (f.kind === 'line') e.poly(LAYERS.sFoundation, f.footprint2D, true);
  else e.poly(LAYERS.sFoundation, f.vertices, true);
}

function systemColor(env: DrawEnv, systemType: string, fallback: string): string {
  const sys = systemType.trim();
  if (!sys) return fallback;
  const def = env.src.input.project.mepSystems.find(s => s.system_type === sys || s.id === sys);
  const color = resolveMepSystemColor(sys, def?.color);
  if (!env.legend.has(sys)) env.legend.set(sys, { label: def?.name && def.name !== sys ? `${sys} ${def.name}` : sys, color });
  return color;
}

/** In an MEP sheet the services sit on top of the faded building; elsewhere walls cover them. */
function mepPhase(env: DrawEnv): Phase {
  return env.src.discipline === 'mep' ? Phase.MepOnTop : Phase.Mep;
}

const MEP_DEFAULT_COLOR: Record<string, string> = {
  duct: '#0096c7', pipe: '#1d4ed8', cable_tray: '#5a8f29', conduit: '#2f7d5b',
};

function drawMepLine(env: DrawEnv, f: MepLineFacts) {
  const { e, pm } = env;
  e.phase = mepPhase(env);
  const color = systemColor(env, f.systemType, MEP_DEFAULT_COLOR[f.table] ?? '#555555');
  const layer = mepLayer(f.table, f.systemType, color);
  const fillColor = tint(color, 0.82);
  const singleLine = (f.table === 'pipe' || f.table === 'conduit') && f.sizeX / pm < 1.6;
  if (f.segments.length === 0) {
    // Vertical riser: its section at the plan
    if (f.shape === 'round' || f.table === 'pipe' || f.table === 'conduit') {
      const r = Math.max(f.sizeX / 2, 0.8 * pm);
      e.push({ kind: 'circle', layer: e.layer(layer), center: f.start, radius: r, fill: fillColor });
      e.line(layer, add(f.start, { x: -r, y: -r }, Math.SQRT1_2), add(f.start, { x: r, y: r }, Math.SQRT1_2), { weight: 0.13 });
    } else if (f.footprint.length >= 3) {
      e.fill(layer, f.footprint, fillColor);
      e.poly(layer, f.footprint, true);
      e.line(layer, f.footprint[0], f.footprint[2], { weight: 0.13 });
    }
    return;
  }
  if (singleLine) {
    e.line(layer, f.start, f.end);
    return;
  }
  for (const seg of f.segments) e.fill(layer, seg.corners, fillColor);
  for (const pts of chainEdges(f.segments.flatMap(s => s.outline), 1e-6 * env.src.upm)) e.poly(layer, pts, false);
  e.line(layer, f.start, f.end, { weight: 0.09, dash: 'center' });
}

function tagOf(el: CanonicalElement): string {
  return (el.attrs.number || el.attrs.name || el.attrs.equipment_type || '').trim();
}

function drawEquipment(env: DrawEnv, el: CanonicalElement, f: EquipmentFacts) {
  const { e, pm } = env;
  const terminal = f.table === 'terminal';
  const color = systemColor(env, el.attrs.system_type || '', '#1a1a1a');
  const pts = rectAt(f.position, f.width, f.depth, f.rotationDeg);
  e.phase = mepPhase(env);
  const def = terminal ? LAYERS.mTerminal : LAYERS.mEquip;
  e.fill(def, pts, '#ffffff');
  e.poly(def, pts, true, terminal ? { color } : {});
  if (terminal) {
    e.line(def, pts[0], pts[2], { color, weight: 0.13 });
    e.line(def, pts[1], pts[3], { color, weight: 0.13 });
    return;
  }
  const tag = tagOf(el);
  if (tag) {
    e.phase = Phase.Tags;
    const h = Math.min(1.8 * pm, f.depth * 0.4);
    e.text(LAYERS.mEquipIden, f.position, tag, h);
  }
}

function drawMepNode(env: DrawEnv, f: MepNodeFacts) {
  if (!f.declaredKind) return; // passive fittings: the runs already meet
  const { e, pm } = env;
  e.phase = mepPhase(env);
  const color = systemColor(env, f.systemType, '#333333');
  const r = Math.max(Math.max(f.sizeW, f.sizeH) / 2, 0.9 * pm);
  e.push({ kind: 'circle', layer: e.layer(LAYERS.mFitting), center: f.position, radius: r, fill: '#ffffff', color });
}

function drawGrids(env: DrawEnv, grids: LineElement[], clip: Box | null) {
  const { e, pm } = env;
  const r = 4.5 * pm;
  for (const g of grids) {
    let a = g.start, b = g.end;
    if (clip) {
      const c = clipSegment(a, b, clip);
      if (!c) continue;
      [a, b] = c;
    }
    if (len(sub(b, a)) < 1e-9) continue;
    e.phase = Phase.GridLine;
    e.line(LAYERS.grid, a, b);
    const label = (g.attrs.number || '').trim();
    if (!label) continue;
    const u = unit(sub(b, a));
    e.phase = Phase.GridBubble;
    for (const [p, dir] of [[a, -1], [b, 1]] as const) {
      const c = add(p, u, dir * r);
      e.push({ kind: 'circle', layer: e.layer(LAYERS.gridIden), center: c, radius: r, fill: '#ffffff' });
      e.text(LAYERS.gridIden, c, label, 3.2 * pm, { bold: true });
    }
  }
}

function drawEntry(env: DrawEnv, entry: Entry) {
  const { el, facts } = entry;
  const { e } = env;
  switch (el.tableName) {
    case 'wall':
    case 'structure_wall':
      return drawWall(env, facts as LineWallFacts);
    case 'curtain_wall':
      return drawCurtainWall(env, facts as CurtainWallFacts);
    case 'door':
      return drawDoor(env, el as LineElement, facts as DoorFacts);
    case 'window':
      return drawWindow(env, el as LineElement, facts as WindowFacts);
    case 'opening': {
      const f = facts as { kind: string; vertices: Point[] };
      if (f.kind === 'polygon' && f.vertices.length >= 3) {
        e.phase = Phase.Openings;
        e.poly(LAYERS.floorOpen, f.vertices, true);
        e.line(LAYERS.floorOpen, f.vertices[0], f.vertices[Math.floor(f.vertices.length / 2)], { weight: 0.13 });
        if (f.vertices.length === 4) e.line(LAYERS.floorOpen, f.vertices[1], f.vertices[3], { weight: 0.13 });
      } else if (el.geometry === 'line') {
        drawWallOpening(env, el as LineElement);
      }
      return;
    }
    case 'column':
    case 'structure_column':
      return drawColumn(env, facts as ColumnFacts, el.tableName);
    case 'slab':
    case 'structure_slab': {
      e.phase = Phase.Below;
      e.poly(el.tableName === 'slab' ? LAYERS.slab : LAYERS.sSlab, (facts as { vertices: Point[] }).vertices, true);
      return;
    }
    case 'roof': {
      e.phase = Phase.Below;
      e.poly(LAYERS.roof, (facts as { vertices: Point[] }).vertices, true);
      return;
    }
    case 'stair':
    case 'stair_run':
      return drawStair(env, facts as StairFacts);
    case 'stair_landing': {
      e.phase = Phase.Floor;
      e.poly(LAYERS.stair, (facts as { vertices: Point[] }).vertices, true);
      return;
    }
    case 'ramp':
      return drawRamp(env, facts as RampFacts);
    case 'railing': {
      const f = facts as { start: Point; end: Point };
      e.phase = Phase.Floor;
      e.line(LAYERS.railing, f.start, f.end);
      return;
    }
    case 'room_separator': {
      const f = facts as { start: Point; end: Point };
      e.phase = Phase.Below;
      e.line(LAYERS.areaBndy, f.start, f.end);
      return;
    }
    case 'space':
      return drawSpace(env, facts as SpaceFacts);
    case 'beam':
    case 'brace': {
      e.phase = Phase.Above;
      e.poly(el.tableName === 'beam' ? LAYERS.sBeam : LAYERS.sBrace, (facts as BeamFacts).footprint2D, true);
      return;
    }
    case 'foundation':
      return drawFoundation(env, facts as FoundationFacts);
    case 'duct':
    case 'pipe':
    case 'cable_tray':
    case 'conduit':
      return drawMepLine(env, facts as MepLineFacts);
    case 'equipment':
    case 'terminal':
      return drawEquipment(env, el, facts as EquipmentFacts);
    case 'mep_node':
      return drawMepNode(env, facts as MepNodeFacts);
  }
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

function growBox(box: Box | null, x0: number, y0: number, x1: number, y1: number): Box {
  if (!box) return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  box.minX = Math.min(box.minX, x0); box.minY = Math.min(box.minY, y0);
  box.maxX = Math.max(box.maxX, x1); box.maxY = Math.max(box.maxY, y1);
  return box;
}

export function itemsBounds(items: DrawItem[], includeDxfOnly = false): Box | null {
  let box: Box | null = null;
  for (const it of items) {
    if (it.dxfOnly && !includeDxfOnly) continue;
    switch (it.kind) {
      case 'path':
        for (const p of it.pts) box = growBox(box, p.x, p.y, p.x, p.y);
        break;
      case 'arc':
      case 'circle':
        box = growBox(box, it.center.x - it.radius, it.center.y - it.radius, it.center.x + it.radius, it.center.y + it.radius);
        break;
      case 'text': {
        const hw = approxTextWidth(it.text, it.height) / 2 + it.height * 0.2;
        const r = Math.max(hw, it.height);
        box = growBox(box, it.at.x - r, it.at.y - r, it.at.x + r, it.at.y + r);
        break;
      }
    }
  }
  return box;
}

/** Extent of the model geometry (no grids), used to fit grids and pick a scale. */
function modelExtent(src: PlanSource): Box | null {
  const env: DrawEnv = { src, e: new Emitter(), pm: paperMm(src.unit, 100), legend: new Map() };
  for (const entry of src.entries) {
    if (entry.el.tableName === 'grid' || roleOf(entry.el.tableName, entry.el.discipline, src.discipline) === 'hidden') continue;
    drawEntry(env, entry);
  }
  // Labels are paper-sized, so leave them out: geometry decides the extent
  return itemsBounds(env.e.items().filter(i => i.kind !== 'text'));
}

// ─── Public ─────────────────────────────────────────────────────────────────

/** Build a level's plan at 1:`scale`. */
export function renderPlan(src: PlanSource, scale: number): PlanDrawing {
  const pm = paperMm(src.unit, scale);
  const e = new Emitter();
  const legend = new Map<string, LegendEntry>();
  const env: DrawEnv = { src, e, pm, legend };
  const grids: LineElement[] = [];
  for (const entry of src.entries) {
    if (entry.el.tableName === 'grid') { grids.push(entry.el as LineElement); continue; }
    const role = roleOf(entry.el.tableName, entry.el.discipline, src.discipline);
    if (role === 'hidden') continue;
    e.halftone = role === 'halftone';
    try { drawEntry(env, entry); } catch (err) { console.warn(`[plan] skipped ${entry.el.id}`, err); }
  }
  e.halftone = false;

  // Grids run a little past the building (or as modelled when shorter)
  const extent = modelExtent(src);
  const over = 12 * pm;
  drawGrids(env, grids, extent && {
    minX: extent.minX - over, minY: extent.minY - over, maxX: extent.maxX + over, maxY: extent.maxY + over,
  });

  e.phase = Phase.Annotation;
  const annotators = src.input.annotators ?? registeredPlanAnnotators();
  if (annotators.length) {
    const elements = [...src.byId.values()];
    for (const fn of annotators) {
      try {
        fn({
          level: src.level, unit: src.unit, scale, pm, upm: src.upm, discipline: src.discipline,
          elements, geometry: src.ctx,
          factsOf: el => src.factsCache.get(el.id) ?? null,
          layer: def => e.layer(def),
          add: item => e.push(item),
        });
      } catch (err) { console.warn('[plan] annotator failed', err); }
    }
  }

  const items = e.items();
  return {
    levelId: src.level.id,
    levelName: src.level.name || src.level.id,
    elevation: src.level.elevation,
    unit: src.unit,
    scale, pm, items,
    layers: e.layers,
    bounds: itemsBounds(items),
    legend: src.discipline === 'architecture' || src.discipline === 'structure' ? [] : [...legend.values()],
  };
}

/** Convenience: collect + render. */
export function buildPlanDrawing(input: PlanInput, scale: number): PlanDrawing | null {
  const src = collectPlan(input);
  return src ? renderPlan(src, scale) : null;
}

/** What to draw, shared by the PDF and DXF exports. */
export interface PlanExportOptions {
  /** `current`: only `levelId`; `all`: every level that has a floor folder. */
  scope?: 'current' | 'all';
  /** The level shown in the editor (used by scope `current`). */
  levelId?: string;
  discipline?: DrawingDiscipline;
  /** Project grids (`state.grids`). */
  grids?: GridData[];
  /** Scale denominator, or `auto` for the largest standard scale that fits. */
  scale?: number | 'auto';
  /** Sheet language (`en` / `zh`), default the UI language. */
  lang?: string;
  /** Title block project name; default the metadata's project_name, else the file name. */
  projectName?: string;
  date?: Date;
  annotators?: readonly PlanAnnotator[];
}

/** Levels to draw, bottom to top. */
export function planLevels(project: ProjectData, opts: PlanExportOptions): Level[] {
  const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
  if ((opts.scope ?? 'all') === 'current') {
    const lv = sorted.find(l => l.id === opts.levelId) ?? sorted.find(l => project.floors.has(l.id));
    return lv ? [lv] : [];
  }
  return sorted.filter(l => project.floors.has(l.id));
}

export function collectPlans(project: ProjectData, opts: PlanExportOptions, lang: DrawingLang): PlanSource[] {
  const out: PlanSource[] = [];
  for (const level of planLevels(project, opts)) {
    const src = collectPlan({
      project, levelId: level.id, grids: opts.grids, discipline: opts.discipline ?? 'all',
      lang, annotators: opts.annotators,
    });
    if (src) out.push(src);
  }
  return out;
}

/** `YYYY-MM-DD`, the same in every locale. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
