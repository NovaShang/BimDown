/**
 * Plan symbol of a library component as SVG elements, in the model's Y-up
 * frame (the canvas wraps everything in scale(1,-1)). Same primitives as
 * `bimdown render`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { arcPath, type PlanFill, type PlanPrim } from './furnitureLibrary.ts';

export interface SymbolStyle {
  stroke: string;
  /** Stroke width in model units. */
  width: number;
  /** Paper fill: masks floor hatching; follows the canvas background. */
  paper?: string;
  dash?: string;
}

const DEFAULT_STYLE: SymbolStyle = { stroke: '#5b6470', width: 0.012, paper: 'var(--bg-canvas, #fff)', dash: '0.06 0.04' };

function fillStyle(fill: PlanFill | undefined, s: SymbolStyle): CSSProperties {
  if (!fill) return { fill: 'none' };
  if (fill === 'paper') return { fill: s.paper ?? '#fff', fillOpacity: 0.92 };
  if (fill === 'tone') return { fill: s.stroke, fillOpacity: 0.16 };
  return { fill: s.stroke };
}

export function renderPrims(prims: PlanPrim[], style: Partial<SymbolStyle> = {}): ReactNode[] {
  const s = { ...DEFAULT_STYLE, ...style };
  return prims.map((p, i) => {
    const dash = 'dash' in p && p.dash ? s.dash : undefined;
    const common = { stroke: s.stroke, strokeWidth: s.width, strokeDasharray: dash };
    switch (p.k) {
      case 'rect':
        return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} {...common} style={fillStyle(p.fill, s)} />;
      case 'circle':
        return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...common} style={fillStyle(p.fill, s)} />;
      case 'ellipse':
        return <ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} {...common} style={fillStyle(p.fill, s)} />;
      case 'line':
        return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} {...common} />;
      case 'poly': {
        const pts = p.pts.map(([x, y]) => `${x},${y}`).join(' ');
        return p.closed
          ? <polygon key={i} points={pts} {...common} style={fillStyle(p.fill, s)} />
          : <polyline key={i} points={pts} {...common} fill="none" />;
      }
      case 'arc':
        return <path key={i} d={arcPath(p)} {...common} fill="none" />;
      case 'text':
        return (
          <text key={i} transform={`translate(${p.x},${p.y}) scale(1,-1)`} fontSize={p.size}
            fill={s.stroke} textAnchor="middle" dominantBaseline="central"
            style={{ fontFamily: 'sans-serif', userSelect: 'none' }}>
            {p.text}
          </text>
        );
    }
  });
}
