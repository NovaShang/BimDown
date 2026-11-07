/**
 * Built-in section families: rect, round, i_shape, t_shape, l_shape, c_shape,
 * cross, rect_hollow, round_hollow. Each owns its parameter list, plan
 * outline, and 3D shape spec. `root_radius` (I/T/L/C root fillets, RHS outer
 * corners) counts in the area (steel weight per metre) and the IFC profile.
 *
 * Heuristic legacy mapping: when only `size_x` / `size_y` are present (older
 * CSVs that predate explicit web/flange/thickness fields), each shape derives
 * proportional defaults so existing data still renders sensibly.
 */
import type { Point } from '../../model/elements.ts';
import { attrNum, registerSectionFamily } from './registry.ts';
import type { SectionFamily } from './types.ts';

/** Default ratios used when explicit web/flange/thickness aren't supplied. */
const FLANGE_RATIO = 0.15;
const WEB_RATIO = 0.1;
const L_THICK_RATIO = 0.15;
const CROSS_THICK_RATIO = 0.25;
/** Default wall thickness of a hollow section: share of its smaller side / diameter. */
const RHS_THICK_RATIO = 0.05;
const CHS_THICK_RATIO = 0.04;

/** Optional non-negative attr (0 when blank): root fillet / corner radius. */
function attrRadius(attrs: Record<string, string>): number {
  const v = parseFloat(attrs.root_radius ?? '');
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Area one root fillet of radius r adds. */
const fillet = (r: number) => (1 - Math.PI / 4) * r * r;

const ROOT_RADIUS_PARAM = { key: 'root_radius', label: 'Root Radius', default: 0, unit: 'm', min: 0, step: 0.001 };

/** CCW polygon of a rounded rectangle (n segments per corner). */
function roundedRectRing(hw: number, hd: number, r: number, n = 4): Point[] {
  const rr = Math.max(0, Math.min(r, hw, hd));
  if (rr < 1e-9) return [{ x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd }];
  const out: Point[] = [];
  const corners: [number, number, number][] = [
    [hw - rr, -hd + rr, -Math.PI / 2], [hw - rr, hd - rr, 0], [-hw + rr, hd - rr, Math.PI / 2], [-hw + rr, -hd + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      out.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }
  return out;
}

function circleRing(r: number, n = 32): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

const rect: SectionFamily = {
  id: 'rect',
  label: 'Rectangular',
  params: [
    { key: 'size_x', label: 'Width', default: 0.3, unit: 'm', min: 0.01, step: 0.05 },
    { key: 'size_y', label: 'Depth', default: 0.3, unit: 'm', min: 0.01, step: 0.05 },
  ],
  resolveParams(attrs) {
    return {
      size_x: attrNum(attrs, 'size_x', 0.3),
      size_y: attrNum(attrs, 'size_y', 0.3),
    };
  },
  outline2D(p) {
    const hw = p.size_x / 2, hd = p.size_y / 2;
    return [
      { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd },
    ];
  },
  shape3D(p) {
    return { kind: 'rect', width: p.size_x, depth: p.size_y };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const round: SectionFamily = {
  id: 'round',
  label: 'Round',
  params: [
    { key: 'size_x', label: 'Diameter', default: 0.3, unit: 'm', min: 0.01, step: 0.05 },
  ],
  resolveParams(attrs) {
    // Older CSVs stored diameter as size_x; some put radius elsewhere. Accept
    // either size_x or 'diameter'.
    const diameter = attrNum(attrs, 'diameter', attrNum(attrs, 'size_x', 0.3));
    return { size_x: diameter };
  },
  outline2D(p) {
    const r = p.size_x / 2;
    // 24-gon tessellation for plan view — visually smooth enough.
    const n = 24;
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return pts;
  },
  shape3D(p) {
    return { kind: 'round', radius: p.size_x / 2 };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_x };
  },
};

/** Shared outline builder for I-shape — produces a 12-point polygon. */
function iOutline(width: number, depth: number, flange: number, web: number): Point[] {
  const hw = width / 2, hd = depth / 2, hwe = web / 2;
  return [
    { x: -hw, y: -hd }, { x: hw, y: -hd },
    { x: hw, y: -hd + flange }, { x: hwe, y: -hd + flange },
    { x: hwe, y: hd - flange }, { x: hw, y: hd - flange },
    { x: hw, y: hd }, { x: -hw, y: hd },
    { x: -hw, y: hd - flange }, { x: -hwe, y: hd - flange },
    { x: -hwe, y: -hd + flange }, { x: -hw, y: -hd + flange },
  ];
}

const i_shape: SectionFamily = {
  id: 'i_shape',
  label: 'I-Shape',
  params: [
    { key: 'size_x', label: 'Flange Width', default: 0.2, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Total Depth', default: 0.4, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'flange', label: 'Flange Thk', default: 0.025, unit: 'm', min: 0.002, step: 0.002 },
    { key: 'web', label: 'Web Thk', default: 0.015, unit: 'm', min: 0.002, step: 0.002 },
    ROOT_RADIUS_PARAM,
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.2);
    const d = attrNum(attrs, 'size_y', 0.4);
    return {
      size_x: w,
      size_y: d,
      flange: attrNum(attrs, 'flange', Math.min(d * FLANGE_RATIO, 0.025)),
      web: attrNum(attrs, 'web', Math.min(w * WEB_RATIO, 0.015)),
      root_radius: attrRadius(attrs),
    };
  },
  outline2D(p) {
    return iOutline(p.size_x, p.size_y, p.flange, p.web);
  },
  area(p) {
    return 2 * p.size_x * p.flange + (p.size_y - 2 * p.flange) * p.web + 4 * fillet(p.root_radius);
  },
  shape3D(p) {
    return { kind: 'i', width: p.size_x, depth: p.size_y, flange: p.flange, web: p.web, radius: p.root_radius };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const t_shape: SectionFamily = {
  id: 't_shape',
  label: 'T-Shape',
  params: [
    { key: 'size_x', label: 'Flange Width', default: 0.2, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Total Depth', default: 0.3, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'flange', label: 'Flange Thk', default: 0.03, unit: 'm', min: 0.002, step: 0.002 },
    { key: 'web', label: 'Web Thk', default: 0.02, unit: 'm', min: 0.002, step: 0.002 },
    ROOT_RADIUS_PARAM,
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.2);
    const d = attrNum(attrs, 'size_y', 0.3);
    return {
      size_x: w, size_y: d,
      flange: attrNum(attrs, 'flange', Math.min(d * 0.2, 0.03)),
      web: attrNum(attrs, 'web', Math.min(w * 0.2, 0.02)),
      root_radius: attrRadius(attrs),
    };
  },
  area(p) {
    return p.size_x * p.flange + (p.size_y - p.flange) * p.web + 2 * fillet(p.root_radius);
  },
  outline2D(p) {
    const hw = p.size_x / 2, hd = p.size_y / 2, hwe = p.web / 2;
    return [
      { x: -hwe, y: -hd }, { x: hwe, y: -hd },
      { x: hwe, y: hd - p.flange }, { x: hw, y: hd - p.flange },
      { x: hw, y: hd }, { x: -hw, y: hd },
      { x: -hw, y: hd - p.flange }, { x: -hwe, y: hd - p.flange },
    ];
  },
  shape3D(p) {
    return { kind: 't', width: p.size_x, depth: p.size_y, flange: p.flange, web: p.web, radius: p.root_radius };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const l_shape: SectionFamily = {
  id: 'l_shape',
  label: 'L-Angle',
  params: [
    { key: 'size_x', label: 'Leg X', default: 0.15, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Leg Y', default: 0.15, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'thickness', label: 'Thickness', default: 0.015, unit: 'm', min: 0.002, step: 0.002 },
    ROOT_RADIUS_PARAM,
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.15);
    const d = attrNum(attrs, 'size_y', 0.15);
    return {
      size_x: w, size_y: d,
      thickness: attrNum(attrs, 'thickness', Math.min(w, d) * L_THICK_RATIO),
      root_radius: attrRadius(attrs),
    };
  },
  area(p) {
    return p.thickness * (p.size_x + p.size_y - p.thickness) + fillet(p.root_radius);
  },
  outline2D(p) {
    const hw = p.size_x / 2, hd = p.size_y / 2, t = p.thickness;
    return [
      { x: -hw, y: -hd }, { x: hw, y: -hd },
      { x: hw, y: -hd + t }, { x: -hw + t, y: -hd + t },
      { x: -hw + t, y: hd }, { x: -hw, y: hd },
    ];
  },
  shape3D(p) {
    return { kind: 'l', width: p.size_x, depth: p.size_y, thickness: p.thickness, radius: p.root_radius };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const c_shape: SectionFamily = {
  id: 'c_shape',
  label: 'C-Channel',
  params: [
    { key: 'size_x', label: 'Flange Width', default: 0.1, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Total Depth', default: 0.2, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'flange', label: 'Flange Thk', default: 0.012, unit: 'm', min: 0.002, step: 0.002 },
    { key: 'web', label: 'Web Thk', default: 0.008, unit: 'm', min: 0.002, step: 0.002 },
    ROOT_RADIUS_PARAM,
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.1);
    const d = attrNum(attrs, 'size_y', 0.2);
    return {
      size_x: w, size_y: d,
      flange: attrNum(attrs, 'flange', Math.min(d * 0.15, 0.012)),
      web: attrNum(attrs, 'web', Math.min(w * 0.2, 0.008)),
      root_radius: attrRadius(attrs),
    };
  },
  area(p) {
    return 2 * p.size_x * p.flange + (p.size_y - 2 * p.flange) * p.web + 2 * fillet(p.root_radius);
  },
  outline2D(p) {
    const hw = p.size_x / 2, hd = p.size_y / 2;
    const fl = p.flange, we = p.web;
    return [
      { x: -hw, y: -hd }, { x: hw, y: -hd },
      { x: hw, y: -hd + fl }, { x: -hw + we, y: -hd + fl },
      { x: -hw + we, y: hd - fl }, { x: hw, y: hd - fl },
      { x: hw, y: hd }, { x: -hw, y: hd },
    ];
  },
  shape3D(p) {
    return { kind: 'c', width: p.size_x, depth: p.size_y, flange: p.flange, web: p.web, radius: p.root_radius };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const cross: SectionFamily = {
  id: 'cross',
  label: 'Cross',
  params: [
    { key: 'size_x', label: 'Width', default: 0.15, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Depth', default: 0.15, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'thickness', label: 'Thickness', default: 0.025, unit: 'm', min: 0.002, step: 0.002 },
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.15);
    const d = attrNum(attrs, 'size_y', 0.15);
    return {
      size_x: w, size_y: d,
      thickness: attrNum(attrs, 'thickness', Math.min(w, d) * CROSS_THICK_RATIO),
    };
  },
  outline2D(p) {
    const hw = p.size_x / 2, hd = p.size_y / 2, ht = p.thickness / 2;
    return [
      { x: -hw, y: -ht }, { x: -ht, y: -ht },
      { x: -ht, y: -hd }, { x: ht, y: -hd },
      { x: ht, y: -ht }, { x: hw, y: -ht },
      { x: hw, y: ht }, { x: ht, y: ht },
      { x: ht, y: hd }, { x: -ht, y: hd },
      { x: -ht, y: ht }, { x: -hw, y: ht },
    ];
  },
  shape3D(p) {
    return { kind: 'cross', width: p.size_x, depth: p.size_y, thickness: p.thickness };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const rect_hollow: SectionFamily = {
  id: 'rect_hollow',
  label: 'Rect. Hollow (RHS/SHS)',
  params: [
    { key: 'size_x', label: 'Width', default: 0.2, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'size_y', label: 'Depth', default: 0.2, unit: 'm', min: 0.02, step: 0.01 },
    { key: 'thickness', label: 'Wall Thk', default: 0.01, unit: 'm', min: 0.001, step: 0.001 },
    { key: 'root_radius', label: 'Corner Radius', default: 0, unit: 'm', min: 0, step: 0.001 },
  ],
  resolveParams(attrs) {
    const w = attrNum(attrs, 'size_x', 0.2);
    const d = attrNum(attrs, 'size_y', 0.2);
    const t = Math.min(attrNum(attrs, 'thickness', Math.min(w, d) * RHS_THICK_RATIO), (Math.min(w, d) / 2) * 0.95);
    return { size_x: w, size_y: d, thickness: t, root_radius: Math.min(attrRadius(attrs), Math.min(w, d) / 2) };
  },
  outline2D(p) {
    return roundedRectRing(p.size_x / 2, p.size_y / 2, p.root_radius);
  },
  holes2D(p) {
    const t = p.thickness;
    return [roundedRectRing(p.size_x / 2 - t, p.size_y / 2 - t, Math.max(0, p.root_radius - t))];
  },
  area(p) {
    const t = p.thickness;
    const ro = p.root_radius, ri = Math.max(0, ro - t);
    return p.size_x * p.size_y - Math.max(0, p.size_x - 2 * t) * Math.max(0, p.size_y - 2 * t)
      - (4 - Math.PI) * (ro * ro - ri * ri);
  },
  shape3D(p) {
    return { kind: 'rect_hollow', width: p.size_x, depth: p.size_y, thickness: p.thickness, radius: p.root_radius };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_y };
  },
};

const round_hollow: SectionFamily = {
  id: 'round_hollow',
  label: 'Circular Hollow (CHS)',
  params: [
    { key: 'size_x', label: 'Diameter', default: 0.2191, unit: 'm', min: 0.01, step: 0.001 },
    { key: 'thickness', label: 'Wall Thk', default: 0.008, unit: 'm', min: 0.001, step: 0.001 },
  ],
  resolveParams(attrs) {
    const dia = attrNum(attrs, 'size_x', 0.2191);
    return { size_x: dia, thickness: Math.min(attrNum(attrs, 'thickness', dia * CHS_THICK_RATIO), (dia / 2) * 0.95) };
  },
  outline2D(p) {
    return circleRing(p.size_x / 2);
  },
  holes2D(p) {
    return [circleRing(p.size_x / 2 - p.thickness)];
  },
  area(p) {
    const ri = p.size_x / 2 - p.thickness;
    return Math.PI * ((p.size_x / 2) ** 2 - ri * ri);
  },
  shape3D(p) {
    return { kind: 'round_hollow', radius: p.size_x / 2, thickness: p.thickness };
  },
  bbox(p) {
    return { w: p.size_x, d: p.size_x };
  },
};

registerSectionFamily(rect);
registerSectionFamily(round);
registerSectionFamily(i_shape);
registerSectionFamily(t_shape);
registerSectionFamily(l_shape);
registerSectionFamily(c_shape);
registerSectionFamily(cross);
registerSectionFamily(rect_hollow);
registerSectionFamily(round_hollow);
