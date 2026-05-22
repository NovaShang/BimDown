/**
 * MEP line elements: duct, pipe, conduit, cable_tray.
 * All share spatial-line archetype + sweep-along-path 3D rendering.
 * The four modules are produced by a single factory and differ only in
 * defaults, colors, and zIndex.
 *
 * (topo-line connector wiring → Step 6 Part B, paired with bimdown-spec schema.)
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { SHAPE_OPTIONS } from './_options.ts';
import {
  mepLineGeometry, mepLineDraw2D, mepLineDraw3D, type MepLineFacts,
} from './_mepLineShared.tsx';

interface MepModuleOpts {
  table: string;
  prefix: string;
  defaults: Record<string, string>;
  drawingFields: any[];
  defaultShape: 'round' | 'rect';
  fill2D: string;
  stroke2D: string;
  strokeWidth2D: number;
  layerStyle: any;
  renderZIndex: number;
}

function makeMepLineModule(opts: MepModuleOpts): ElementModule<MepLineFacts> {
  return {
    table: opts.table,
    discipline: 'mep',
    archetype: 'topo-line',
    prefix: opts.prefix,
    csvHeaders: [
      'number', 'base_offset', 'start_z', 'end_z', 'shape',
      'size_x', 'size_y', 'system_type', 'start_node_id', 'end_node_id',
    ],
    defaults: opts.defaults,
    drawingFields: opts.drawingFields,
    propertyFields: [],
    layerStyle: opts.layerStyle,
    renderZIndex: opts.renderZIndex,

    geometry(el: CanonicalElement, ctx: GeometryContext): MepLineFacts | null {
      return mepLineGeometry(el, ctx, opts.table, opts.defaultShape);
    },

    draw2D(facts, drawCtx): ReactNode {
      const stroke = drawCtx.selected ? '#3a7bff' : opts.stroke2D;
      return mepLineDraw2D(facts, opts.fill2D, stroke, opts.strokeWidth2D);
    },

    draw3D(facts, drawCtx): ReactNode {
      return mepLineDraw3D(facts, drawCtx.selected || drawCtx.hovered);
    },

    bbox(facts) {
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
}

export const ductModule = makeMepLineModule({
  table: 'duct', prefix: 'du',
  defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.2', size_y: '0.2', system_type: 'hvac' },
  drawingFields: [
    { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
  ],
  defaultShape: 'rect',
  fill2D: '#00b4d815',
  stroke2D: '#00b4d8',
  strokeWidth2D: 0.025,
  layerStyle: { displayName: 'Ducts', color: '#00b4d8', icon: '═', order: 10 },
  renderZIndex: 80,
});

export const pipeModule = makeMepLineModule({
  table: 'pipe', prefix: 'pi',
  defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.05', size_y: '0.05', system_type: 'plumbing' },
  drawingFields: [
    { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
  ],
  defaultShape: 'round',
  fill2D: '#06d6a015',
  stroke2D: '#06d6a0',
  strokeWidth2D: 0.02,
  layerStyle: { displayName: 'Pipes', color: '#06d6a0', icon: '║', order: 11 },
  renderZIndex: 81,
});

export const conduitModule = makeMepLineModule({
  table: 'conduit', prefix: 'co',
  defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.025', size_y: '0.025', system_type: 'electrical' },
  drawingFields: [
    { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.005, step: 0.005 },
  ],
  defaultShape: 'round',
  fill2D: '#ffd16615',
  stroke2D: '#ffd166',
  strokeWidth2D: 0.015,
  layerStyle: { displayName: 'Conduits', color: '#ffd166', icon: '│', order: 14 },
  renderZIndex: 83,
});

export const cableTrayModule = makeMepLineModule({
  table: 'cable_tray', prefix: 'ct',
  defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'rect', size_x: '0.1', size_y: '0.1', system_type: 'electrical' },
  drawingFields: [
    { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
  ],
  defaultShape: 'rect',
  fill2D: '#ffd16615',
  stroke2D: '#ffd166',
  strokeWidth2D: 0.02,
  layerStyle: { displayName: 'Cable Trays', color: '#ffd166', icon: '╤', order: 15 },
  renderZIndex: 82,
});

registerElement(ductModule);
registerElement(pipeModule);
registerElement(conduitModule);
registerElement(cableTrayModule);
