/**
 * Ceiling — surface archetype.
 * Like slab but hung from the level above by `height_offset` (typically negative,
 * e.g. -0.3m drop). Same polygon footprint + opening holes as slab.
 */
import type { ReactNode } from 'react';
import type { ElementModule } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';
import { slabGeometryFor, slabDraw2D, slabDraw3D, type SlabFacts } from './_slabShared.tsx';

const DEFAULT_HEIGHT_OFFSET = -0.3;

export const ceilingModule: ElementModule<SlabFacts> = {
  table: 'ceiling',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'cl',
  csvHeaders: ['number', 'base_offset', 'material', 'height_offset'],
  defaults: { base_offset: '0', material: 'gypsum', height_offset: '-0.3' },
  drawingFields: [
    { key: 'height_offset', label: 'Drop', type: 'number', unit: 'm', step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Ceilings', color: '#b0bec5', icon: '▤', order: 7.8 },
  renderZIndex: 18,

  geometry(el: CanonicalElement, ctx): SlabFacts | null {
    if (el.geometry !== 'polygon') return null;
    const heightOffset = parseFloat(el.attrs.height_offset || `${DEFAULT_HEIGHT_OFFSET}`);
    return slabGeometryFor(el as PolygonElement, ctx, 'ceiling', 'gypsum',
      Number.isFinite(heightOffset) ? heightOffset : DEFAULT_HEIGHT_OFFSET);
  },

  draw2D(facts, drawCtx): ReactNode {
    // Light gray dashed outline for plan view (ceiling is overhead).
    const stroke = drawCtx.selected ? '#3a7bff' : '#b0bec5';
    return slabDraw2D(facts, 'rgba(176,190,197,0.04)', stroke);
  },

  draw3D(facts, drawCtx): ReactNode {
    return slabDraw3D(facts, drawCtx.selected || drawCtx.hovered);
  },

  bbox(facts) {
    if (facts.vertices.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.vertices) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(ceilingModule);
