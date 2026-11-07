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

const DUCT_STEP = 0.05;
const DN = [0.015, 0.02, 0.025, 0.032, 0.04, 0.05, 0.065, 0.08, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];

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
    const d = Math.ceil(D / DUCT_STEP - 1e-9) * DUCT_STEP;
    return { shape, sizeX: d, sizeY: d, velocity: q / (Math.PI * d * d / 4), friction: frictionRate(q, d, 'air') };
  }
  let h = currentH > 0 ? currentH : 0;
  const widthFor = (hh: number) => {
    let w = hh;
    while (equivalentDiameter(w, hh) < D && w < 4) w += 0.01;
    return Math.ceil(w / DUCT_STEP - 1e-9) * DUCT_STEP;
  };
  let w = h > 0 ? widthFor(h) : 0;
  if (!(h > 0) || w / h > 4 || w < h * 0.5) {
    h = Math.max(0.1, Math.ceil((D / 1.4) / DUCT_STEP) * DUCT_STEP);
    w = widthFor(h);
  }
  const De = equivalentDiameter(w, h);
  return { shape, sizeX: w, sizeY: h, velocity: q / (w * h), friction: frictionRate(q, De, 'air') };
}

/** Pipe size: smallest DN with velocity ≤ 1.5 m/s (≤ DN50) / 2.5 m/s and friction ≤ 300 Pa/m. */
export function sizePipe(flowLs: number): SizeSuggestion | null {
  const q = flowLs / 1000;
  if (!(q > 0)) return null;
  for (const d of DN) {
    const v = q / (Math.PI * d * d / 4);
    const vmax = d <= 0.05 ? 1.5 : 2.5;
    const r = frictionRate(q, d, 'water');
    if (v <= vmax && r <= 300) return { shape: 'round', sizeX: d, sizeY: d, velocity: v, friction: r };
  }
  const d = DN[DN.length - 1];
  return { shape: 'round', sizeX: d, sizeY: d, velocity: q / (Math.PI * d * d / 4), friction: frictionRate(q, d, 'water') };
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

/** Elements resized to their suggested size for `system` (ducts / pipes of that system). */
export function sizeSystem(elements: ReadonlyMap<string, CanonicalElement>, system: string, rate = 1.0): CanonicalElement[] {
  const flows = computeRunFlows(elements);
  const out: CanonicalElement[] = [];
  for (const el of elements.values()) {
    if ((el.tableName !== 'duct' && el.tableName !== 'pipe') || (el.attrs.system_type || '') !== system) continue;
    if ((el.attrs.flexible || '') === 'true') continue;
    const f = flows.get(el.id) ?? 0;
    const shape = (el.attrs.shape || (el.tableName === 'duct' ? 'rect' : 'round')) === 'round' ? 'round' : 'rect';
    const s = el.tableName === 'duct'
      ? sizeDuct(f, shape, parseFloat(el.attrs.size_y || '0') || 0, rate)
      : sizePipe(f);
    if (!s) continue;
    const sx = String(round3(s.sizeX)), sy = String(round3(s.sizeY));
    if (el.attrs.size_x === sx && (shape === 'round' || el.attrs.size_y === sy)) continue;
    const ln = el as MepCurve;
    out.push({ ...ln, strokeWidth: s.sizeX, attrs: { ...ln.attrs, size_x: sx, size_y: sy } });
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Plan length of a run and its fall (for slope display). */
export function runSlope(el: MepCurve): number {
  const l = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y);
  if (l < 1e-6) return 0;
  return (endZ(el, 'end') - endZ(el, 'start')) / l;
}
