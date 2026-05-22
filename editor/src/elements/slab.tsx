import type { ReactNode } from 'react';
import type { ElementModule } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import { MATERIAL_OPTIONS, SLAB_FUNCTION_OPTIONS, STRUCTURE_SLAB_FUNCTION_OPTIONS } from './_options.ts';
import { slabGeometryFor, slabDraw2D, slabDraw3D, type SlabFacts } from './_slabShared.tsx';

function makeSlabModule(opts: {
  table: string;
  prefix: string;
  discipline: string;
  defaults: Record<string, string>;
  fill: string;
  stroke: string;
  layerStyle: any;
  renderZIndex: number;
  functionOptions: typeof SLAB_FUNCTION_OPTIONS;
}): ElementModule<SlabFacts> {
  return {
    table: opts.table,
    discipline: opts.discipline,
    archetype: 'surface',
    prefix: opts.prefix,
    csvHeaders: ['number', 'base_offset', 'material', 'function', 'thickness'],
    defaults: opts.defaults,
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'function', label: 'Function', type: 'select', options: opts.functionOptions },
      { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    ],
    propertyFields: [],
    layerStyle: opts.layerStyle,
    renderZIndex: opts.renderZIndex,

    geometry(el: CanonicalElement, ctx): SlabFacts | null {
      if (el.geometry !== 'polygon') return null;
      return slabGeometryFor(el as PolygonElement, ctx, opts.table, opts.defaults.material);
    },

    draw2D(facts, drawCtx): ReactNode {
      const stroke = drawCtx.selected ? '#3a7bff' : opts.stroke;
      return slabDraw2D(facts, opts.fill, stroke);
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
}

export const slabModule = makeSlabModule({
  table: 'slab', prefix: 'sl', discipline: 'architecture',
  defaults: { base_offset: '0', material: 'concrete', function: 'floor', thickness: '0.2' },
  fill: 'rgba(128,128,128,0.06)',
  stroke: '#9e9e9e',
  layerStyle: { displayName: 'Slabs', color: '#adb5bd', icon: '▨', order: 7 },
  renderZIndex: 20,
  functionOptions: SLAB_FUNCTION_OPTIONS,
});

export const structureSlabModule = makeSlabModule({
  table: 'structure_slab', prefix: 'ss', discipline: 'structure',
  defaults: { base_offset: '0', material: 'concrete', function: 'floor', thickness: '0.2' },
  fill: 'rgba(141,110,99,0.08)',
  stroke: '#8d6e63',
  layerStyle: { displayName: 'Str. Slabs', color: '#8d6e63', icon: '▨', order: 8 },
  renderZIndex: 21,
  functionOptions: STRUCTURE_SLAB_FUNCTION_OPTIONS,
});

registerElement(slabModule);
registerElement(structureSlabModule);
