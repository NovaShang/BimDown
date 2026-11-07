/**
 * Tier-1 MEP calculations: design flow carried by each run (terminal flows
 * summed towards the source), velocity, friction, and a size suggestion by
 * equal friction (ducts) or velocity / friction limits (pipes).
 *
 * Network: runs connect through fittings (bare node refs), inline
 * accessories (`node:in` / `node:out`) and device ports. The source of a
 * connected network is its equipment with the largest flow (AHU, chiller,
 * pump), else an open end; terminals with a flow are the loads. Loops
 * are cut by the traversal (spanning tree), which is fine for sizing.
 */
import type { CanonicalElement, LineElement, SpatialLineElement } from '../model/elements.ts';
import { isMepLineTable } from '../model/mepTopology.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { endZ } from '../model/mepSplit.ts';
import { DE_MM, DN_MM, RECT_DUCT_MM, ROUND_DUCT_MM, isPlasticPipe, upToSeries } from './sizes.ts';
import { portSection, transitionsForRuns } from './transitions.ts';
import { reservedIds } from './reservedIds.ts';
import { sameSize } from './routeTool.ts';

type MepCurve = LineElement | SpatialLineElement;

export interface RunFlow {
  /** L/s carried by the run. */
  flow: number;
}

const AIR = { rho: 1.2, nu: 1.5e-5, eps: 0.00009 };   // galvanised steel duct
const WATER = { rho: 998, nu: 1.0e-6, eps: 0.000045 }; // steel pipe

/** Darcy friction factor (Altshul–Tsal, as in the ASHRAE duct design chapter). */
function friction(D: number, V: number, fluid: typeof AIR): number {
  const Re = Math.max(V * D / fluid.nu, 1);
  const f1 = 0.11 * Math.pow(fluid.eps / D + 68 / Re, 0.25);
  return f1 >= 0.018 ? f1 : 0.85 * f1 + 0.0028;
}

/** Pressure drop per metre (Pa/m) for flow `q` (m³/s) in a round section of diameter `D` (m). */
export function frictionRate(q: number, D: number, fluid: 'air' | 'water'): number {
  const fl = fluid === 'air' ? AIR : WATER;
  const A = Math.PI * D * D / 4;
  const V = q / A;
  return friction(D, V, fl) / D * fl.rho * V * V / 2;
}

/** Equivalent round diameter of a rectangular duct (Huebscher). */
export function equivalentDiameter(w: number, h: number): number {
  return 1.3 * Math.pow(w * h, 0.625) / Math.pow(w + h, 0.25);
}

export interface SizeSuggestion {
  shape: 'round' | 'rect';
  sizeX: number;
  sizeY: number;
  velocity: number;
  friction: number;
}

const RECT_M = RECT_DUCT_MM.map(v => v / 1000);
const DN = DN_MM.map(v => v / 1000);
/** Plastic pipes: outside diameter de and a typical bore (PN10 / SDR 11). */
const DE = DE_MM.map(v => v / 1000);
const plasticBore = (de: number) => de * (1 - 2 / 11);

/**
 * Duct size for `flowLs` by equal friction (`rate` Pa/m, default 1.0).
 * Rectangular ducts keep their height when it gives aspect ≤ 4, else pick a
 * height for aspect ~2; widths round up to 50 mm.
 */
export function sizeDuct(flowLs: number, shape: 'round' | 'rect', currentH: number, rate = 1.0): SizeSuggestion | null {
  const q = flowLs / 1000;
  if (!(q > 0)) return null;
  let lo = 0.05, hi = 3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (frictionRate(q, mid, 'air') > rate) lo = mid; else hi = mid;
  }
  const D = hi;
  if (shape === 'round') {
    // Standard spiral duct diameters.
    const d = upToSeries(D * 1000, ROUND_DUCT_MM) / 1000;
    return { shape, sizeX: d, sizeY: d, velocity: q / (Math.PI * d * d / 4), friction: frictionRate(q, d, 'air') };
  }
  // Smallest standard width giving the equivalent diameter at height hh.
  const widthFor = (hh: number) => RECT_M.find(w => equivalentDiameter(w, hh) >= D) ?? RECT_M[RECT_M.length - 1];
  // Keep the current height when the aspect stays between 1:1 and 4:1,
  // otherwise pick the standard height closest to a 1.5:1 aspect.
  let h = currentH > 0 ? currentH : 0;
  let w = h > 0 ? widthFor(h) : 0;
  if (!(h > 0) || w / h > 4 || w / h < 1) {
    let best = { score: Infinity, w: 0, h: 0 };
    for (const hh of RECT_M) {
      if (hh > 1.2 + 1e-9) break;
      const ww = widthFor(hh);
      if (ww < hh) continue;
      const score = Math.abs(Math.log(ww / hh / 1.5));
      if (score < best.score) best = { score, w: ww, h: hh };
    }
    w = best.w; h = best.h;
  }
  const De = equivalentDiameter(w, h);
  return { shape, sizeX: w, sizeY: h, velocity: q / (w * h), friction: frictionRate(q, De, 'air') };
}

/**
 * Water pipe size: smallest DN (metal) or de (plastic, by its bore) with
 * velocity ≤ 1.5 m/s (≤ DN50) / 2.5 m/s and friction ≤ 300 Pa/m.
 */
export function sizePipe(flowLs: number, material?: string): SizeSuggestion | null {
  const q = flowLs / 1000;
  if (!(q > 0)) return null;
  const plastic = isPlasticPipe(material);
  const series = plastic ? DE : DN;
  const bore = (d: number) => plastic ? plasticBore(d) : d;
  const fit = (d: number) => {
    const b = bore(d);
    return { shape: 'round' as const, sizeX: d, sizeY: d, velocity: q / (Math.PI * b * b / 4), friction: frictionRate(q, b, 'water') };
  };
  for (const d of series) {
    const s = fit(d);
    const vmax = bore(d) <= 0.05 ? 1.5 : 2.5;
    if (s.velocity <= vmax && s.friction <= 300) return s;
  }
  return fit(series[series.length - 1]);
}

/** Velocity and friction of a run as drawn. */
export function runHydraulics(curve: CanonicalElement, flowLs: number): { velocity: number; friction: number } | null {
  const q = flowLs / 1000;
  if (!(q > 0)) return null;
  const w = parseFloat(curve.attrs.size_x || '0') || 0;
  const h = parseFloat(curve.attrs.size_y || '0') || w;
  if (!(w > 0)) return null;
  const round = (curve.attrs.shape || (curve.tableName === 'duct' ? 'rect' : 'round')) === 'round';
  const A = round ? Math.PI * w * w / 4 : w * h;
  const D = round ? w : equivalentDiameter(w, h);
  const fluid = curve.tableName === 'duct' ? 'air' : 'water';
  return { velocity: q / A, friction: frictionRate(q, D, fluid) };
}

/**
 * Flow (L/s) carried by every MEP run, keyed by curve id. Runs with no
 * downstream load get 0.
 */
export function computeRunFlows(elements: ReadonlyMap<string, CanonicalElement>): Map<string, number> {
  // Graph vertices: "h:<host>" for fittings / accessories / devices, "e:<curve>:<side>" for open ends.
  const adj = new Map<string, { curve: string; other: string }[]>();
  const link = (a: string, b: string, curve: string) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ curve, other: b });
    adj.get(b)!.push({ curve, other: a });
  };
  const hostKey = (ref: string | undefined, curveId: string, side: string) => {
    const p = parsePortRef(ref);
    return p ? `h:${p.hostId}` : `e:${curveId}:${side}`;
  };
  const curves: MepCurve[] = [];
  for (const el of elements.values()) {
    if (!isMepLineTable(el.tableName) || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    const c = el as MepCurve;
    curves.push(c);
    link(hostKey(c.attrs.from, c.id, 's'), hostKey(c.attrs.to, c.id, 'e'), c.id);
  }
  const load = new Map<string, number>();
  const sources: { key: string; flow: number }[] = [];
  for (const el of elements.values()) {
    if (el.tableName !== 'terminal' && el.tableName !== 'equipment') continue;
    const f = parseFloat(el.attrs.flow || '0') || 0;
    const key = `h:${el.id}`;
    if (!adj.has(key)) continue;
    // Equipment are sources / pass-through (an FCU's rated flow is air, not its
    // chilled water); terminals are the loads.
    if (el.tableName === 'equipment') sources.push({ key, flow: f });
    else load.set(key, f);
  }
  const flows = new Map<string, number>();
  const visited = new Set<string>();
  const subtree = (root: string): number => {
    // Iterative post-order DFS: flow of a run = loads beyond it.
    const stack: { v: string; via: string | null; i: number; sum: number }[] = [{ v: root, via: null, i: 0, sum: 0 }];
    visited.add(root);
    let result = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = adj.get(top.v) ?? [];
      if (top.i < edges.length) {
        const e = edges[top.i++];
        if (e.curve === top.via || visited.has(e.other)) continue;
        visited.add(e.other);
        stack.push({ v: e.other, via: e.curve, i: 0, sum: 0 });
        continue;
      }
      stack.pop();
      const own = top.v === root ? 0 : (load.get(top.v) ?? 0);
      const total = top.sum + own;
      if (top.via) flows.set(top.via, total);
      if (stack.length) stack[stack.length - 1].sum += total;
      else result = total;
    }
    return result;
  };
  // Sources first (biggest flow), then whatever is left from an open end.
  sources.sort((a, b) => b.flow - a.flow);
  for (const s of sources) if (!visited.has(s.key)) subtree(s.key);
  for (const v of adj.keys()) if (!visited.has(v) && v.startsWith('e:')) subtree(v);
  for (const v of adj.keys()) if (!visited.has(v)) subtree(v);
  for (const c of curves) if (!flows.has(c.id)) flows.set(c.id, 0);
  return flows;
}

export interface SizeSystemOpts {
  /** Equal-friction rate for ducts, Pa/m. */
  rate?: number;
  /** Runs past the last branch (no flow) take the size of the run before them. */
  deadEnds?: boolean;
  /** Add transitions where a resized run meets a device port of another size. */
  transitions?: boolean;
  /** For new transition nodes. */
  levelId?: string;
}

/**
 * Elements resized to their suggested size for `system` (ducts / pipes of
 * that system), plus the transitions they now need at device ports.
 */
export function sizeSystem(elements: ReadonlyMap<string, CanonicalElement>, system: string, opts: SizeSystemOpts | number = {}): CanonicalElement[] {
  const o: SizeSystemOpts = typeof opts === 'number' ? { rate: opts } : opts;
  const rate = o.rate ?? 1.0;
  const flows = computeRunFlows(elements);
  const sized = new Map<string, { sx: string; sy: string }>();
  const members: MepCurve[] = [];
  const stubs = new Set<string>();
  for (const el of elements.values()) {
    if ((el.tableName !== 'duct' && el.tableName !== 'pipe') || (el.attrs.system_type || '') !== system) continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if ((el.attrs.flexible || '') === 'true') continue;
    members.push(el as MepCurve);
    if (isPortStub(el as MepCurve, elements)) { stubs.add(el.id); continue; }
    const f = flows.get(el.id) ?? 0;
    const shape = (el.attrs.shape || (el.tableName === 'duct' ? 'rect' : 'round')) === 'round' ? 'round' : 'rect';
    const s = el.tableName === 'duct'
      ? sizeDuct(f, shape, parseFloat(el.attrs.size_y || '0') || 0, rate)
      : sizePipe(f, el.attrs.material);
    if (s) sized.set(el.id, { sx: String(round3(s.sizeX)), sy: String(round3(s.sizeY)) });
  }
  if (o.deadEnds ?? true) {
    // Dead ends: a run with no flow joined through a fitting to sized runs takes the smallest of them.
    const byNode = new Map<string, MepCurve[]>();
    for (const c of members) for (const r of [c.attrs.from, c.attrs.to]) {
      const p = parsePortRef(r);
      if (!p || p.portName) continue;
      const list = byNode.get(p.hostId) ?? [];
      list.push(c);
      byNode.set(p.hostId, list);
    }
    const area = (v: { sx: string; sy: string }) => (parseFloat(v.sx) || 0) * (parseFloat(v.sy) || 0);
    for (let pass = 0; pass < members.length; pass++) {
      let changed = false;
      for (const c of members) {
        if (sized.has(c.id) || stubs.has(c.id)) continue;
        let best: { sx: string; sy: string } | null = null;
        for (const r of [c.attrs.from, c.attrs.to]) {
          const p = parsePortRef(r);
          if (!p || p.portName) continue;
          for (const n of byNode.get(p.hostId) ?? []) {
            const v = n.id !== c.id ? sized.get(n.id) : undefined;
            if (v && (!best || area(v) < area(best))) best = v;
          }
        }
        if (best) { sized.set(c.id, best); changed = true; }
      }
      if (!changed) break;
    }
  }
  const resized: MepCurve[] = [];
  for (const c of members) {
    const v = sized.get(c.id);
    if (!v) continue;
    const round = (c.attrs.shape || (c.tableName === 'duct' ? 'rect' : 'round')) === 'round';
    if (c.attrs.size_x === v.sx && (round || c.attrs.size_y === v.sy)) continue;
    resized.push({ ...c, strokeWidth: parseFloat(v.sx), attrs: { ...c.attrs, size_x: v.sx, size_y: v.sy } } as MepCurve);
  }
  if (!(o.transitions ?? true)) return resized;
  // Where a resized run meets a device port of another size: a stub at the port size.
  const live = new Map(elements);
  for (const c of resized) live.set(c.id, c);
  return transitionsForRuns(resized, live, reservedIds(live), o.levelId ?? '');
}

/** A short run at a device port's size (a transition stub or a neck): sizing leaves it. */
function isPortStub(c: MepCurve, elements: ReadonlyMap<string, CanonicalElement>): boolean {
  const len = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y, endZ(c, 'end') - endZ(c, 'start'));
  if (len > 1.0) return false;
  return [c.attrs.from, c.attrs.to].some(r => {
    const p = portSection(r, elements);
    return !!p && parseFloat(p.w) > 0 && sameSize(c.attrs, p, c.tableName);
  });
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Plan length of a run and its fall (for slope display). */
export function runSlope(el: MepCurve): number {
  const l = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y);
  if (l < 1e-6) return 0;
  return (endZ(el, 'end') - endZ(el, 'start')) / l;
}
