/**
 * The editor's plan symbols are small React SVG trees (MEP terminals,
 * equipment, accessories). This turns such a tree into drawing items, so the
 * PDF / DXF sheets show the same symbols as the canvas: rect, circle,
 * ellipse, line, polyline, polygon, path (M / L / H / V / A / Z) and text,
 * with nested `transform`s (translate / rotate / scale). Stroke widths are
 * left to the layer pen; fills keep their colour (opacity mixed with white).
 */
import { isValidElement, type ReactNode } from 'react';
import type { Point } from '../../model/elements.ts';
import type { DrawItem } from './types.ts';

/** 2D affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function mul(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
export const rotateDeg = (deg: number): Affine => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
};

const apply = (m: Affine, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function parseTransform(t: string | undefined): Affine {
  let m: Affine = IDENTITY;
  if (!t) return m;
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'translate') m = mul(m, translate(v[0] ?? 0, v[1] ?? 0));
    else if (fn === 'rotate') {
      const r = rotateDeg(v[0] ?? 0);
      m = v.length >= 3 ? mul(mul(mul(m, translate(v[1], v[2])), r), translate(-v[1], -v[2])) : mul(m, r);
    } else if (fn === 'scale') m = mul(m, [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]);
  }
  return m;
}

const n = (v: unknown, d = 0) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(x) ? x : d;
};

/** Mix a CSS colour with white for an opacity (hex / named black-white only). */
function solid(color: unknown, opacity: unknown): string | undefined {
  if (typeof color !== 'string' || color === 'none' || color === 'transparent' || color.startsWith('var(')) return undefined;
  const o = Math.max(0, Math.min(1, n(opacity, 1)));
  const hex = color === 'white' ? '#ffffff' : color === 'black' ? '#000000' : color;
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? /^#([0-9a-f]{3})$/i.exec(hex);
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * o + 255 * (1 - o)).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, k = 32): [number, number][] {
  return Array.from({ length: k }, (_, i) => [cx + rx * Math.cos((i / k) * 2 * Math.PI), cy + ry * Math.sin((i / k) * 2 * Math.PI)]);
}

/** SVG elliptical arc (endpoint form) sampled into points, excluding the start. */
function arcPts(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): [number, number][] {
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const k = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  return Array.from({ length: k }, (_, i) => {
    const t = t1 + (dt * (i + 1)) / k;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [cp * x - sp * y + cx, sp * x + cp * y + cy] as [number, number];
  });
}

/** Path data → sub-paths (points + closed). Supports M L H V A Z (absolute). */
function pathPts(d: string): { pts: [number, number][]; closed: boolean }[] {
  const out: { pts: [number, number][]; closed: boolean }[] = [];
  const tok = d.match(/[MLHVAZmlhvaz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0, cmd = '', cur: [number, number] = [0, 0];
  let sub: { pts: [number, number][]; closed: boolean } | null = null;
  const next = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    switch (cmd.toUpperCase()) {
      case 'M': cur = [next(), next()]; sub = { pts: [cur], closed: false }; out.push(sub); cmd = 'L'; break;
      case 'L': cur = [next(), next()]; sub?.pts.push(cur); break;
      case 'H': cur = [next(), cur[1]]; sub?.pts.push(cur); break;
      case 'V': cur = [cur[0], next()]; sub?.pts.push(cur); break;
      case 'A': {
        const [rx, ry, rot, la, sw, x, y] = [next(), next(), next(), next(), next(), next(), next()];
        sub?.pts.push(...arcPts(cur[0], cur[1], rx, ry, rot, la === 1, sw === 1, x, y));
        cur = [x, y];
        break;
      }
      case 'Z': if (sub) sub.closed = true; break;
      default: i++;
    }
  }
  return out;
}

export interface SymbolTarget {
  layer: string;
  /** Ink of the layer: strokes in another colour get a colour override. */
  layerColor: string;
  push(item: DrawItem): void;
}

/** Emit the drawing items of an SVG React tree under transform `m`. */
export function svgToItems(node: ReactNode, m: Affine, t: SymbolTarget): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { for (const c of node) svgToItems(c, m, t); return; }
  if (!isValidElement(node)) return;
  const p = node.props as Record<string, unknown> & { children?: ReactNode };
  const mm = p.transform ? mul(m, parseTransform(String(p.transform))) : m;
  const stroke = typeof p.stroke === 'string' && p.stroke !== 'none' ? p.stroke : undefined;
  const fill = solid(p.fill, p.fillOpacity);
  const base = {
    layer: t.layer,
    ...(stroke && stroke.toLowerCase() !== t.layerColor.toLowerCase() && !stroke.startsWith('var(') ? { color: stroke } : {}),
    ...(p.strokeDasharray ? { dash: 'dashed' as const } : {}),
  };
  const poly = (pts: [number, number][], closed: boolean, filled = true) => {
    if (pts.length < 2) return;
    t.push({
      kind: 'path', ...base, pts: pts.map(([x, y]) => apply(mm, x, y)), closed,
      ...(closed && filled && fill ? { fill } : {}), ...(!stroke ? { noStroke: true } : {}),
    } as DrawItem);
  };
  switch (node.type) {
    case 'g': case 'svg': break;
    case 'rect': {
      const x = n(p.x), y = n(p.y), w = n(p.width), h = n(p.height);
      poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
      break;
    }
    case 'circle': poly(ellipsePts(n(p.cx), n(p.cy), n(p.r), n(p.r)), true); break;
    case 'ellipse': poly(ellipsePts(n(p.cx), n(p.cy), n(p.rx), n(p.ry)), true); break;
    case 'line': poly([[n(p.x1), n(p.y1)], [n(p.x2), n(p.y2)]], false); break;
    case 'polyline':
    case 'polygon': {
      const v = String(p.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      poly(pts, node.type === 'polygon');
      break;
    }
    case 'path': for (const s of pathPts(String(p.d ?? ''))) poly(s.pts, s.closed); break;
    case 'text': {
      const text = typeof p.children === 'string' || typeof p.children === 'number' ? String(p.children) : '';
      if (!text) break;
      const at = apply(mm, n(p.x), n(p.y));
      const size = n(p.fontSize, 0.2) * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      t.push({ kind: 'text', ...base, at, text, height: size * 0.72, align: 'center', valign: 'middle', rotation: Math.atan2(mm[1], mm[0]) } as DrawItem);
      return;
    }
    default: break;
  }
  if (p.children !== undefined && node.type !== 'text') svgToItems(p.children, mm, t);
}
