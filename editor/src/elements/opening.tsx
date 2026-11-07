import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point, PolygonElement } from '../model/elements.ts';
import { isShaft } from '../model/crossLevel.ts';
import { ShaftCross } from './_slabShared.tsx';

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
  /** A vertical shaft through the levels up to top_level_id. */
  shaft?: boolean;
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
  hostTables: ['wall', 'curtain_wall', 'structure_wall', 'slab', 'structure_slab', 'roof'],
  widthAttr: 'width',
  csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'width', 'height', 'shape', 'top_level_id', 'top_offset'],
  defaults: {
    base_offset: '0', host_id: '', position: '0.5',
    width: '1.0', height: '2.4', shape: 'rect',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'shape', label: 'Shape', type: 'select', options: OPENING_SHAPE_OPTIONS },
    { key: 'top_level_id', label: 'Top', type: 'select' },
    { key: 'top_offset', label: 'Top Offset', type: 'number', unit: 'm', step: 0.1 },
    { key: 'base_offset', label: 'Base Offset', type: 'number', unit: 'm', step: 0.1 },
  ],
  // Wall opening (click a wall), opening sketched in a floor / roof, or a
  // shaft cutting every floor and roof up to its top level.
  toolbarVariants: [
    { id: 'wall', label: 'layer.opening_wall', icon: '▢', iconName: 'opening', placementType: 'hosted', fields: ['width', 'height', 'shape'] },
    { id: 'sketch', label: 'layer.opening_sketch', icon: '⬚', iconName: 'opening', placementType: 'free_polygon', fields: [] },
    {
      id: 'shaft', label: 'layer.shaft', icon: '⊠', iconName: 'opening', placementType: 'free_polygon',
      fields: ['base_offset', 'top_level_id', 'top_offset'],
    },
  ],
  // A shaft rises to the next level by default.
  placementDefaults: ({ levels, levelId, variantId }): Record<string, string> => {
    if (variantId !== 'shaft') return { top_level_id: '', top_offset: '0' };
    const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
    const i = sorted.findIndex(l => l.id === levelId);
    return { top_level_id: sorted[i + 1]?.id ?? levelId, top_offset: sorted[i + 1] ? '0' : '3', base_offset: '0' };
  },
  propertyFields: [],
  dualMode: true,
  layerStyle: { displayName: 'Openings', color: '#ff8a65', icon: '▢', order: 5.8 },
  renderZIndex: 62,

  geometry(el: CanonicalElement, _ctx: GeometryContext): OpeningFacts | null {
    if (el.geometry === 'polygon') {
      const p = el as PolygonElement;
      if (p.vertices.length < 3) return null;
      return { id: p.id, kind: 'polygon', vertices: p.vertices, shaft: isShaft(p) };
    }
    // Line-hosted opening: no 2D representation (handled by host's cutout).
    return { id: el.id, kind: 'line-hosted', vertices: [] };
  },

  draw2D(facts): ReactNode {
    if (facts.kind === 'line-hosted') return null;
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    return (
      <g data-id={facts.id}>
        <polygon
          points={points}
          fill="rgba(255,138,101,0.06)"
          stroke="#ff8a65"
          strokeWidth={facts.shaft ? 0.03 : 0.02}
          strokeDasharray={facts.shaft ? undefined : '0.05 0.03'}
          data-id={facts.id}
        />
        {facts.shaft && <ShaftCross poly={facts.vertices} stroke="#ff8a65" />}
      </g>
    );
  },

  draw3D(): ReactNode {
    // TODO 3c: opening renders as CSG cut on host via wall.draw3D.
    return null;
  },
};

registerElement(openingModule);
