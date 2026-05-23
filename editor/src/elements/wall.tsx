import type { ReactNode } from 'react';
import type { ElementModule } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';
import {
  wallGeometryFor, wallDraw2D, wallDraw3D, wallFillFor,
  type LineWallFacts, type WallOpening,
} from './_lineWallShared.tsx';

export type WallFacts = LineWallFacts;
export type { WallOpening };

export const wallModule: ElementModule<WallFacts> = {
  table: 'wall',
  discipline: 'architecture',
  archetype: 'line',
  prefix: 'w',
  hasVerticalSpan: true,
  csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'thickness'],
  defaults: { base_offset: '0', thickness: '0.2', top_level_id: '', top_offset: '0', material: 'concrete' },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Walls', color: '#1a1a2e', icon: '▬', order: 1 },
  renderZIndex: 40,

  geometry(el: CanonicalElement, ctx): WallFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    return wallGeometryFor(el as LineElement, ctx, 'wall');
  },

  draw2D(facts, drawCtx): ReactNode {
    const fill = wallFillFor(facts.material);
    const stroke = drawCtx.selected ? '#3a7bff' : '#1a1a2e';
    const strokeWidth = drawCtx.selected ? 0.04 : 0.03;
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

registerElement(wallModule);
