/**
 * Drawing items as SVG (the on-screen twin of the PDF painter): put it in a
 * group whose user space is the drawing's own coordinates, Y up (the caller
 * flips). Strokes without fill are merged into one <path> per pen, so a
 * section with thousands of lines stays a handful of DOM nodes.
 */
import { memo, type ReactNode } from 'react';
import type { DrawingLayer, LineDash } from '../export/drawing/layers.ts';
import type { DrawItem } from '../export/drawing/types.ts';
import { tint } from '../export/drawing/color.ts';

const DASH_MM: Record<LineDash, number[]> = {
  solid: [],
  dashed: [2.0, 1.0],
  hidden: [1.5, 0.8],
  center: [7, 1.2, 1.2, 1.2],
};

/** Cap height → font size (Helvetica-like faces). */
const CAP = 0.72;
const FONT = 'Helvetica, Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

const f = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

interface Pen { color: string; width: number; dash: string }

function penOf(it: DrawItem, layers: Map<string, DrawingLayer>, pm: number): Pen {
  const layer = layers.get(it.layer);
  let color = it.color ?? layer?.color ?? '#000000';
  if (it.halftone) color = tint(color, 0.6);
  const weight = Math.max(it.weight ?? layer?.weight ?? 0.18, 0.05);
  const dash = it.dash ?? layer?.dash ?? 'solid';
  return { color, width: weight * pm, dash: DASH_MM[dash].map(v => f(v * pm)).join(' ') };
}

function arcPath(c: { x: number; y: number }, r: number, start: number, end: number): string {
  let sweep = end - start;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep >= Math.PI * 2 - 1e-9) {
    return `M${f(c.x + r)},${f(c.y)}A${f(r)},${f(r)} 0 1 1 ${f(c.x - r)},${f(c.y)}A${f(r)},${f(r)} 0 1 1 ${f(c.x + r)},${f(c.y)}`;
  }
  const a = { x: c.x + r * Math.cos(start), y: c.y + r * Math.sin(start) };
  const b = { x: c.x + r * Math.cos(start + sweep), y: c.y + r * Math.sin(start + sweep) };
  return `M${f(a.x)},${f(a.y)}A${f(r)},${f(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(b.x)},${f(b.y)}`;
}

export const DrawingItemsSvg = memo(function DrawingItemsSvg({ items, layers, pm }: {
  items: DrawItem[];
  layers: Map<string, DrawingLayer>;
  /** Drawing units per paper mm (line weights and text are paper sizes). */
  pm: number;
}) {
  const out: ReactNode[] = [];
  // Unfilled strokes merged per pen, flushed when a filled shape or text comes
  // (keeps the paint order the PDF uses)
  let batch = new Map<string, { pen: Pen; d: string[] }>();
  const flush = () => {
    for (const [key, { pen, d }] of batch) {
      out.push(<path key={`s${out.length}-${key}`} d={d.join('')} fill="none" stroke={pen.color} strokeWidth={pen.width}
        strokeDasharray={pen.dash || undefined} strokeLinecap="round" strokeLinejoin="round" />);
    }
    batch = new Map();
  };
  const stroke = (it: DrawItem, d: string) => {
    const pen = penOf(it, layers, pm);
    const key = `${pen.color}|${pen.width}|${pen.dash}`;
    const b = batch.get(key);
    if (b) b.d.push(d); else batch.set(key, { pen, d: [d] });
  };
  for (const it of items) {
    if (it.dxfOnly) continue;
    switch (it.kind) {
      case 'path': {
        if (it.pts.length < 2) break;
        const d = `M${it.pts.map(p => `${f(p.x)},${f(p.y)}`).join('L')}${it.closed ? 'Z' : ''}`;
        if (!it.fill) { if (!it.noStroke) stroke(it, d); break; }
        flush();
        const pen = it.noStroke ? null : penOf(it, layers, pm);
        out.push(<path key={out.length} d={d} fill={it.halftone ? tint(it.fill, 0.65) : it.fill}
          stroke={pen?.color ?? 'none'} strokeWidth={pen?.width} strokeDasharray={pen?.dash || undefined} strokeLinejoin="round" />);
        break;
      }
      case 'circle': {
        if (!it.fill) {
          if (!it.noStroke) stroke(it, arcPath(it.center, it.radius, 0, Math.PI * 2));
          break;
        }
        flush();
        const pen = it.noStroke ? null : penOf(it, layers, pm);
        out.push(<circle key={out.length} cx={f(it.center.x)} cy={f(it.center.y)} r={f(it.radius)}
          fill={it.halftone ? tint(it.fill, 0.65) : it.fill} stroke={pen?.color ?? 'none'} strokeWidth={pen?.width} />);
        break;
      }
      case 'arc':
        stroke(it, arcPath(it.center, it.radius, it.start, it.end));
        break;
      case 'text': {
        flush();
        const layer = layers.get(it.layer);
        let color = it.color ?? layer?.color ?? '#1a1a1a';
        if (it.halftone) color = tint(color, 0.55);
        const deg = ((it.rotation ?? 0) * 180) / Math.PI;
        out.push(
          <text key={out.length} transform={`translate(${f(it.at.x)},${f(it.at.y)}) scale(1,-1) rotate(${f(-deg)})`}
            fontSize={f(it.height / CAP)} fontFamily={FONT} fontWeight={it.bold ? 700 : 400} fill={color}
            textAnchor={it.align === 'center' ? 'middle' : it.align === 'right' ? 'end' : 'start'}
            dominantBaseline={it.valign === 'middle' ? 'central' : 'alphabetic'}>
            {it.text}
          </text>,
        );
        break;
      }
    }
  }
  flush();
  return <>{out}</>;
});
