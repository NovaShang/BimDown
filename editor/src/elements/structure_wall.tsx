import type { ReactNode } from 'react';
import type { ElementModule } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { MATERIAL_OPTIONS } from '../model/tableRegistry.ts';
import {
  wallGeometryFor, wallDraw2D, wallDraw3D, wallFillFor,
  type LineWallFacts,
} from './_lineWallShared.tsx';

export const structureWallModule: ElementModule<LineWallFacts> = {
  table: 'structure_wall',
  discipline: 'structure',
  archetype: 'line',
  prefix: 'sw',
  hasVerticalSpan: true,
  csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'thickness'],
  defaults: { base_offset: '0', thickness: '0.2', top_level_id: '', top_offset: '0', material: 'concrete' },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Str. Walls', color: '#4a3728', icon: '▬', order: 2 },
  renderZIndex: 41,

  geometry(el: CanonicalElement, ctx): LineWallFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    return wallGeometryFor(el as LineElement, ctx, 'structure_wall');
  },

  draw2D(facts, drawCtx): ReactNode {
    const fill = wallFillFor(facts.material);
    const stroke = drawCtx.selected ? '#3a7bff' : '#4a3728';
    const strokeWidth = drawCtx.selected ? 0.04 : 0.04;
    return wallDraw2D(facts, fill, stroke, strokeWidth);
  },

  draw3D(facts, drawCtx): ReactNode {
    return wallDraw3D(facts, drawCtx.selected || drawCtx.hovered);
  },

  bbox(facts) {
    if (facts.footprint.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.footprint) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(structureWallModule);
