import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';

const EXT = 200;

export interface GridFacts {
  id: string;
  ex1: number; ey1: number; ex2: number; ey2: number;
  startLabel: Point;
  label: string;
}

export const gridModule: ElementModule<GridFacts> = {
  table: 'grid',
  discipline: 'reference',
  archetype: 'line',
  placementType: 'grid',
  prefix: 'gr',
  csvHeaders: ['number'],
  defaults: {},
  drawingFields: [],
  propertyFields: [],
  layerStyle: { displayName: 'Grids', color: '#ef476f', icon: '┼', order: 0 },
  renderZIndex: 1,
  isSnapTarget: false,

  geometry(el: CanonicalElement, _ctx: GeometryContext): GridFacts | null {
    if (el.geometry !== 'line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
    const ux = dx / len, uy = dy / len;
    return {
      id: ln.id,
      ex1: ln.start.x - ux * EXT, ey1: ln.start.y - uy * EXT,
      ex2: ln.end.x + ux * EXT, ey2: ln.end.y + uy * EXT,
      startLabel: ln.start,
      label: ln.attrs.number || ln.id,
    };
  },

  draw2D(facts): ReactNode {
    const color = '#ef476f';
    return (
      <g data-id={facts.id}>
        {/* Dash-dot pattern: long dash, gap, dot, gap — standard architectural
            convention. Stroke a touch thicker + higher opacity than before so
            grids actually read as reference lines instead of ghosts. */}
        <line x1={facts.ex1} y1={facts.ey1} x2={facts.ex2} y2={facts.ey2}
          stroke={color} strokeWidth={0.04}
          strokeDasharray="0.6 0.12 0.04 0.12" opacity={0.85} />
        {/* Transparent fat hit line for selection. */}
        <line x1={facts.ex1} y1={facts.ey1} x2={facts.ex2} y2={facts.ey2}
          stroke="transparent" strokeWidth={0.6} data-id={facts.id} />
        {/* Bubble label at the start endpoint — Revit-style filled circle so
            the grid id pops against the floor plan instead of blending in. */}
        <g transform={`translate(${facts.startLabel.x},${facts.startLabel.y}) scale(1,-1)`}>
          <circle cx={0} cy={0} r={0.5} fill="#ffffff" stroke={color}
            strokeWidth={0.05} opacity={0.95} />
          <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
            fontSize={0.45} fontFamily="Inter, sans-serif" fontWeight="700"
            fill={color}>
            {facts.label}
          </text>
        </g>
      </g>
    );
  },

  draw3D(): ReactNode {
    // Grids are 2D references only — V1 doesn't render them in 3D either.
    return null;
  },
};

registerElement(gridModule);
