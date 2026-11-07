/**
 * Plan symbols of `furniture` rows as SVG markup (for `bimdown render`).
 * Coordinates are model space, Y up: the caller wraps the output in the
 * composite's `scale(1,-1)` group.
 */
import { arcPath, furniturePlan, resolveFurniture, type PlanFill, type PlanPrim } from './library.js';

const STROKE = '#4b5563';
const LINE = 0.012;
const FILLS: Record<PlanFill, string> = { paper: '#ffffff', tone: '#e5e7eb', dark: '#4b5563' };

function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  return Number(n.toFixed(4)).toString();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paint(fill: PlanFill | undefined, dash: boolean | undefined): string {
  const f = fill ? FILLS[fill] : 'none';
  const d = dash ? ` stroke-dasharray="0.06,0.04"` : '';
  return `fill="${f}" stroke="${STROKE}" stroke-width="${LINE}"${d}`;
}

export function primToSvg(p: PlanPrim): string {
  switch (p.k) {
    case 'rect':
      return `<rect x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(p.w)}" height="${fmt(p.h)}"${p.r ? ` rx="${fmt(p.r)}"` : ''} ${paint(p.fill, p.dash)} />`;
    case 'circle':
      return `<circle cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" r="${fmt(p.r)}" ${paint(p.fill, p.dash)} />`;
    case 'ellipse':
      return `<ellipse cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" rx="${fmt(p.rx)}" ry="${fmt(p.ry)}" ${paint(p.fill, p.dash)} />`;
    case 'line':
      return `<line x1="${fmt(p.x1)}" y1="${fmt(p.y1)}" x2="${fmt(p.x2)}" y2="${fmt(p.y2)}" ${paint(undefined, p.dash)} />`;
    case 'poly': {
      const pts = p.pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
      return p.closed
        ? `<polygon points="${pts}" ${paint(p.fill, p.dash)} />`
        : `<polyline points="${pts}" ${paint(undefined, p.dash)} />`;
    }
    case 'arc':
      return `<path d="${arcPath(p)}" ${paint(undefined, p.dash)} />`;
    case 'text':
      // Text reads upright: undo the composite's Y flip at the anchor.
      return `<text transform="translate(${fmt(p.x)},${fmt(p.y)}) scale(1,-1)" font-size="${fmt(p.size)}" font-family="sans-serif" fill="${STROKE}" text-anchor="middle" dominant-baseline="central">${esc(p.text)}</text>`;
  }
}

export interface FurnitureSvg {
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** One furniture row (CSV attrs + point + rotation) as an SVG group. */
export function furnitureToSvg(
  id: string,
  attrs: Record<string, string | undefined>,
  x: number,
  y: number,
  rotationDeg: number,
): FurnitureSvg {
  const r = resolveFurniture(attrs);
  const body = furniturePlan(r).map(primToSvg).join('');
  const rot = rotationDeg ? ` rotate(${fmt(rotationDeg)})` : '';
  const svg = `    <g id="${esc(id)}" transform="translate(${fmt(x)},${fmt(y)})${rot}">${body}</g>`;
  // Rotated footprint bounds.
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hx = (r.params.w * c + r.params.d * s) / 2;
  const hy = (r.params.w * s + r.params.d * c) / 2;
  return { svg, bounds: { minX: x - hx, minY: y - hy, maxX: x + hx, maxY: y + hy } };
}
