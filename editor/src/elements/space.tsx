import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, PolygonElement, Point } from '../model/elements.ts';

export interface SpaceFacts {
  id: string;
  kind: 'point' | 'polygon';
  /** Anchor point — point.position or polygon centroid. */
  anchor: Point;
  vertices?: Point[];
  number: string;
  name: string;
}

function centroid(vertices: Point[]): Point {
  let area = 0, cx = 0, cy = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10) {
    const sx = vertices.reduce((s, v) => s + v.x, 0) / n;
    const sy = vertices.reduce((s, v) => s + v.y, 0) / n;
    return { x: sx, y: sy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export const spaceModule: ElementModule<SpaceFacts> = {
  table: 'space',
  discipline: 'architecture',
  archetype: 'point',  // typically a seed point; legacy polygon still supported
  prefix: 'sp',
  csvOnly: true,
  csvHeaders: ['number', 'base_offset', 'x', 'y', 'name'],
  defaults: { base_offset: '0', x: '0', y: '0', name: '' },
  drawingFields: [
    { key: 'name', label: 'Name', type: 'text' },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Spaces', color: '#3a86ff', icon: '⬡', order: 6 },
  renderZIndex: 10,

  geometry(el: CanonicalElement, _ctx: GeometryContext): SpaceFacts | null {
    const number = el.attrs.number || '';
    const name = el.attrs.name || '';
    if (el.geometry === 'point') {
      const pt = el as PointElement;
      return { id: el.id, kind: 'point', anchor: pt.position, number, name };
    }
    if (el.geometry === 'polygon') {
      const poly = el as PolygonElement;
      if (poly.vertices.length < 3) return null;
      return {
        id: el.id, kind: 'polygon',
        anchor: centroid(poly.vertices),
        vertices: poly.vertices,
        number, name,
      };
    }
    return null;
  },

  draw2D(facts, drawCtx): ReactNode {
    // Polygon spaces: dashed outline. Selection turns the boundary solid
    // and fills the interior to make the room's extent obvious.
    const highlight = drawCtx.selected;
    const outline = facts.kind === 'polygon' && facts.vertices ? (
      <polygon
        points={facts.vertices.map(v => `${v.x},${v.y}`).join(' ')}
        fill={highlight ? 'rgba(58,134,255,0.18)' : 'rgba(58,134,255,0.06)'}
        stroke={highlight ? '#3a7bff' : '#3a86ff'}
        strokeWidth={highlight ? 0.05 : 0.03}
        strokeDasharray={highlight ? undefined : '0.15,0.08'}
      />
    ) : null;

    if (!facts.number && !facts.name) {
      return <g data-id={facts.id}>{outline}</g>;
    }
    const { x, y } = facts.anchor;
    return (
      <g data-id={facts.id}>
        {outline}
        {facts.number && (
          <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
            fontSize={0.4} fontFamily="Inter, sans-serif" fontWeight={700} fill="#3a86ff"
            transform={`translate(${x},${y}) scale(1,-1) translate(${-x},${-y})`}>
            {facts.number}
          </text>
        )}
        {facts.name && (
          <text x={x} y={y - 0.45} textAnchor="middle" dominantBaseline="central"
            fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={500} fill="#5a9fff"
            transform={`translate(${x},${y - 0.45}) scale(1,-1) translate(${-x},${-(y - 0.45)})`}>
            {facts.name}
          </text>
        )}
      </g>
    );
  },

  draw3D(): ReactNode {
    // V1: spaces don't render visible 3D mesh (they're labels in 2D).
    return null;
  },
};

registerElement(spaceModule);
