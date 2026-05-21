import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point, PolygonElement } from '../model/elements.ts';

/**
 * Openings are dual-mode:
 *  - on a line host (wall): no 2D representation — implicit in wall cutout
 *  - polygon (slab/roof opening): dashed outline
 */
export interface OpeningFacts {
  id: string;
  kind: 'line-hosted' | 'polygon';
  /** Polygon vertices for the slab/roof opening case. */
  vertices: Point[];
}

const OPENING_TABLE = 'opening';

const OPENING_SHAPE_OPTIONS = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'round', label: 'Round' },
  { value: 'arch', label: 'Arch' },
];

export const openingModule: ElementModule<OpeningFacts> = {
  table: OPENING_TABLE,
  discipline: 'architecture',
  archetype: 'hosted',
  prefix: 'op',
  hostType: 'wall',
  hostTables: ['wall', 'curtain_wall', 'structure_wall', 'slab', 'structure_slab'],
  widthAttr: 'width',
  csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'width', 'height', 'shape'],
  defaults: {
    base_offset: '0', host_id: '', position: '0.5',
    width: '1.0', height: '2.4', shape: 'rect',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'shape', label: 'Shape', type: 'select', options: OPENING_SHAPE_OPTIONS },
  ],
  propertyFields: [],
  dualMode: true,
  layerStyle: { displayName: 'Openings', color: '#ff8a65', icon: '▢', order: 5.8 },
  renderZIndex: 62,

  geometry(el: CanonicalElement, _ctx: GeometryContext): OpeningFacts | null {
    if (el.geometry === 'polygon') {
      const p = el as PolygonElement;
      if (p.vertices.length < 3) return null;
      return { id: p.id, kind: 'polygon', vertices: p.vertices };
    }
    // Line-hosted opening: no 2D representation (handled by host's cutout).
    return { id: el.id, kind: 'line-hosted', vertices: [] };
  },

  draw2D(facts): ReactNode {
    if (facts.kind === 'line-hosted') return null;
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    return (
      <polygon
        points={points}
        fill="rgba(255,138,101,0.06)"
        stroke="#ff8a65"
        strokeWidth={0.02}
        strokeDasharray="0.05 0.03"
        data-id={facts.id}
      />
    );
  },

  draw3D(): ReactNode {
    // TODO 3c: opening renders as CSG cut on host via wall.draw3D.
    return null;
  },
};

registerElement(openingModule);
