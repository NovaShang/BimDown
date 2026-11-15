/**
 * Structural sections: the measured profile (IFC parametric profile, or an
 * arbitrary outline read back as I / C / T / L / hollow / round / rect) and
 * the steel designation in the type or family name (W460X60, HEA200, IPE300,
 * HSS152X152X9.5, CHS114.3X6.3, L100X100X10, C250X30, H400X200X8X13 …).
 *
 * Data-driven so a section library can plug in: `DESIGNATIONS` maps names to
 * a section kind (and the dimensions the name spells out), `SHAPE_OF` maps a
 * kind to the schema's `shape` value (hollow sections are stored as rect /
 * round with their wall in `thickness` until the format has hollow shapes),
 * and `lookupSection` may be replaced by a library lookup by designation.
 */
import type { AttrValue } from './context.js';
import type { Profile } from './representation.js';
import { type V2, polygonArea, r3 } from './math.js';

export type SectionKind = 'rect' | 'round' | 'i' | 't' | 'l' | 'c' | 'rhs' | 'chs';

export interface Section {
  kind: SectionKind;
  /** Flange width / leg X / outer width / diameter (m). */
  width: number;
  /** Total depth / leg Y / outer depth (m); = width for round. */
  depth: number;
  flange?: number;
  web?: number;
  /** Leg thickness (L), wall thickness (hollow). */
  thickness?: number;
  /** Catalogue designation from the name, e.g. "W460X60". */
  designation?: string;
}

/** Schema `shape` per section kind. */
export const SHAPE_OF: Record<SectionKind, string> = {
  rect: 'rect', round: 'round', i: 'i_shape', t: 't_shape', l: 'l_shape', c: 'c_shape', rhs: 'rect', chs: 'round',
};

/** Hook for a section library: dimensions of a designation (m), or null. */
export let lookupSection: (designation: string, kind: SectionKind) => Section | null = () => null;
export function setSectionLookup(fn: typeof lookupSection): void { lookupSection = fn; }

const n = (s: string | undefined) => (s === undefined ? NaN : s.includes('/') ? s.split('/').map(Number).reduce((a, b) => a / b) : parseFloat(s));
/** Metric names are in mm; imperial HSS / L sizes (≤ 40) in inches. */
const unit = (v: number, imperial: boolean) => (imperial ? v * 0.0254 : v / 1000);

const X = '\\s?[xX×*]\\s?';
const NUM = '(\\d+(?:\\.\\d+)?(?:\\/\\d+)?)';

export interface Designation {
  re: RegExp;
  kind: SectionKind;
  /** Dimensions the name itself gives (m), from the match. */
  dims?: (m: RegExpMatchArray) => Partial<Section> | null;
}

// First match wins.
export const DESIGNATIONS: Designation[] = [
  // Hollow: HSS B×H×t (rect) or D×t (round), CHS / RHS / SHS, Chinese 方管 / 圆管
  { re: new RegExp(`\\bHSS\\s?${NUM}${X}${NUM}${X}${NUM}`, 'i'), kind: 'rhs', dims: m => {
    const imp = n(m[1]) <= 40;
    return { width: unit(n(m[1]), imp), depth: unit(n(m[2]), imp), thickness: unit(n(m[3]), imp) };
  } },
  { re: new RegExp(`\\b(?:HSS|CHS|PIPE|圆管|Ø|φ)\\s?${NUM}${X}${NUM}`, 'i'), kind: 'chs', dims: m => {
    const imp = n(m[1]) <= 40;
    return { width: unit(n(m[1]), imp), depth: unit(n(m[1]), imp), thickness: unit(n(m[2]), imp) };
  } },
  { re: new RegExp(`\\b(?:RHS|SHS|方管|矩形管)\\s?${NUM}${X}${NUM}(?:${X}${NUM})?`, 'i'), kind: 'rhs', dims: m => (
    { width: unit(n(m[1]), false), depth: unit(n(m[2]), false), thickness: m[3] ? unit(n(m[3]), false) : undefined }) },
  // Welded / Chinese H: H depth × width × web × flange
  { re: new RegExp(`\\b(?:H|HN|HW|HM|BH|WH)\\s?${NUM}${X}${NUM}${X}${NUM}${X}${NUM}`, 'i'), kind: 'i', dims: m => (
    { depth: unit(n(m[1]), false), width: unit(n(m[2]), false), web: unit(n(m[3]), false), flange: unit(n(m[4]), false) }) },
  // Tees cut from I sections (before W / M / S)
  { re: /\b(?:WT|MT|ST)\s?\d+(?:\.\d+)?(?:\s?[xX×]\s?\d+(?:\.\d+)?)?/i, kind: 't' },
  // Angles: L leg × leg × t
  { re: new RegExp(`\\bL\\s?${NUM}${X}${NUM}(?:${X}${NUM})?`, 'i'), kind: 'l', dims: m => {
    const imp = n(m[1]) <= 12;
    return { width: unit(n(m[1]), imp), depth: unit(n(m[2]), imp), thickness: m[3] ? unit(n(m[3]), imp) : undefined };
  } },
  // I / H rolled sections
  { re: /\b(?:W|HP|M|S)\s?\d+(?:\.\d+)?\s?[xX×]\s?\d+(?:\.\d+)?/, kind: 'i' },
  { re: /\b(?:IPE|IPN|HE[ABM]|HE|HD|HL|UB|UC|UBP|HN|HW|HM)\s?\d+(?:\s?[xX×]\s?\d+(?:\.\d+)?)*[A-Z]?\b/i, kind: 'i' },
  { re: /工字钢|H型钢|\bI\s?\d+[abc]?\b/i, kind: 'i' },
  // Channels
  { re: /\b(?:C|MC)\s?\d+(?:\.\d+)?\s?[xX×]\s?\d+(?:\.\d+)?/, kind: 'c' },
  { re: /\b(?:UPN|UPE|PFC|UAP)\s?\d+(?:\s?[xX×]\s?\d+(?:\.\d+)?)*|槽钢\s?\d*[abc]?|\[\s?\d+[abc]?/i, kind: 'c' },
  { re: /角钢|∠/, kind: 'l' },
];

/** The designation token of a name ("M_W-Wide Flange:W460X60" → W460X60) and its kind. */
export function parseDesignation(text: string | undefined): { designation: string; kind: SectionKind; dims: Partial<Section> } | null {
  if (!text) return null;
  for (const d of DESIGNATIONS) {
    const m = text.match(d.re);
    if (!m) continue;
    const designation = m[0].replace(/\s+/g, '').toUpperCase();
    return { designation, kind: d.kind, dims: d.dims?.(m) ?? {} };
  }
  return null;
}

/** Section of a parametric profile, or of an arbitrary outline read back. */
export function measuredSection(p: Profile | null): Section | null {
  switch (p?.kind) {
    case 'rect': return p.hollow ? { kind: 'rhs', width: p.x, depth: p.y, thickness: p.hollow } : { kind: 'rect', width: p.x, depth: p.y };
    case 'circle': return p.hollow ? { kind: 'chs', width: p.r * 2, depth: p.r * 2, thickness: p.hollow } : { kind: 'round', width: p.r * 2, depth: p.r * 2 };
    case 'i': return { kind: 'i', width: p.width, depth: p.depth, flange: p.flange, web: p.web };
    case 't': return { kind: 't', width: p.width, depth: p.depth, flange: p.flange, web: p.web };
    case 'l': return { kind: 'l', width: p.width, depth: p.depth, thickness: p.thickness };
    case 'c': return { kind: 'c', width: p.width, depth: p.depth, flange: p.flange, web: p.web };
    case 'polygon': return outlineSection(p.points, p.voids ?? []) ?? outlineSection(p.points.map(q => ({ x: q.y, y: q.x })), (p.voids ?? []).map(v => v.map(q => ({ x: q.y, y: q.x }))));
    default: return null;
  }
}

/** Width of a closed ring along the horizontal line at `y`: total interior length, and the intervals. */
function scan(ring: V2[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

const total = (iv: [number, number][]) => iv.reduce((s, [a, b]) => s + (b - a), 0);

/**
 * An outline read as a section: rect, round, I (flanges top and bottom, web
 * centred), C (web at one side), T, L; with a void, hollow rect / round.
 * Null when it is none of these (the caller keeps the body extents).
 */
export function outlineSection(ring: V2[], voids: V2[][]): Section | null {
  if (ring.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of ring) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const W = maxX - minX, D = maxY - minY;
  if (!(W > 1e-4 && D > 1e-4)) return null;
  const area = Math.abs(polygonArea(ring));
  const fill = area / (W * D);
  const round = ring.length >= 12 && Math.abs(W - D) < 0.02 * W && Math.abs(fill - Math.PI / 4) < 0.03;
  if (voids.length === 1) {
    const v = voids[0];
    let vx0 = Infinity, vx1 = -Infinity;
    for (const p of v) { vx0 = Math.min(vx0, p.x); vx1 = Math.max(vx1, p.x); }
    const t = (W - (vx1 - vx0)) / 2;
    if (t > 0 && t < W / 2) {
      if (round) return { kind: 'chs', width: W, depth: W, thickness: t };
      if (fill > 0.97) return { kind: 'rhs', width: W, depth: D, thickness: t };
    }
    return null;
  }
  if (round) return { kind: 'round', width: W, depth: W };
  if (fill > 0.98) return { kind: 'rect', width: W, depth: D };
  const at = (f: number) => scan(ring, minY + f * D);
  const top = at(0.995), bot = at(0.005), mid = at(0.5);
  const wTop = total(top), wBot = total(bot), wMid = total(mid);
  if (mid.length !== 1) return null;
  const cx = (minX + maxX) / 2;
  const midC = (mid[0][0] + mid[0][1]) / 2;
  const full = (w: number) => w > 0.9 * W;
  const thin = (w: number) => w < 0.6 * W;
  /** Distance from an edge (top: from maxY down) to where the width falls below 90 %. */
  const plate = (fromTop: boolean) => {
    let lo = 0, hi = 0.5; // fraction of D from the edge: lo inside the plate, hi past it
    for (let k = 0; k < 30; k++) {
      const m = (lo + hi) / 2;
      const w = total(at(fromTop ? 1 - m : m));
      if (w > 0.9 * W) lo = m; else hi = m;
    }
    return lo * D;
  };
  const centred = Math.abs(midC - cx) < 0.1 * W;
  const atSide = Math.min(Math.abs(mid[0][0] - minX), Math.abs(maxX - mid[0][1])) < 0.02 * W;
  if (full(wTop) && full(wBot) && thin(wMid)) {
    const flange = Math.min(plate(true), plate(false));
    if (centred) return { kind: 'i', width: W, depth: D, flange, web: wMid };
    if (atSide) return { kind: 'c', width: W, depth: D, flange, web: wMid };
    return null;
  }
  if (full(wTop) !== full(wBot) && thin(wMid)) {
    const fromTop = full(wTop);
    const leg = total(at(fromTop ? 0.005 : 0.995));
    if (centred) return { kind: 't', width: W, depth: D, flange: plate(fromTop), web: wMid };
    if (atSide && Math.abs(leg - wMid) < 0.02 * W) return { kind: 'l', width: W, depth: D, thickness: wMid };
  }
  return null;
}

/** Best section: measured kinds win; a name refines a plain outline (or the lack of one) and labels the section. */
export function resolveSection(measured: Section | null, extents: { x: number; y: number }, names: (string | undefined)[], roundHint = false): Section {
  const des = names.map(parseDesignation).find(Boolean) ?? null;
  let s: Section = measured ?? (roundHint ? { kind: 'round', width: Math.max(extents.x, extents.y), depth: Math.max(extents.x, extents.y) } : { kind: 'rect', width: extents.x, depth: extents.y });
  if (des) {
    const lib = lookupSection(des.designation, des.kind);
    if (lib) s = { ...lib };
    else if (!measured || (measured.kind === 'rect' && des.kind !== 'rect')) {
      // Plain outline or none: the name says what it is
      s = { kind: des.kind, width: des.dims.width ?? s.width, depth: des.dims.depth ?? s.depth, ...des.dims };
    } else if ((s.kind === 'rhs' || s.kind === 'chs' || s.kind === 'l') && !s.thickness && des.dims.thickness) s.thickness = des.dims.thickness;
    s.designation = des.designation;
  }
  return s;
}

/** structural_section_profile columns of a section (`rectOnly`: architectural columns take rect / round). */
export function sectionColumns(s: Section, rectOnly = false): Record<string, AttrValue> {
  if (rectOnly) {
    return s.kind === 'round' || s.kind === 'chs' ? { shape: 'round', size_x: r3(s.width) } : { shape: 'rect', size_x: r3(s.width), size_y: r3(s.depth) };
  }
  const shape = SHAPE_OF[s.kind];
  const out: Record<string, AttrValue> = { shape, size_x: r3(s.width) };
  if (shape !== 'round') out.size_y = r3(s.depth);
  if (s.flange) out.flange = r3(s.flange);
  if (s.web) out.web = r3(s.web);
  if (s.thickness) out.thickness = r3(s.thickness);
  return out;
}
