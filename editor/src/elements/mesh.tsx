/**
 * Mesh — point archetype for non-parametric annotation elements. May reference
 * an external .glb file via attrs.mesh_file; the 3D loading path is handled by
 * adapters/r3f's MeshInstances component (FloorGroup routes mesh_file elements
 * there separately). This module only owns the 2D bbox annotation.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';

export interface MeshFacts {
  id: string;
  position: Point;
  width: number;
  height: number;
  rotationDeg: number;
}

export const meshModule: ElementModule<MeshFacts> = {
  table: 'mesh',
  discipline: 'reference',
  archetype: 'point',
  prefix: 'ms',
  csvHeaders: ['category', 'name', 'level_id', 'mesh_file', 'x', 'y', 'z', 'rotation'],
  defaults: { category: '', name: '', level_id: '', mesh_file: '', x: '0', y: '0', z: '0', rotation: '0' },
  drawingFields: [
    { key: 'category', label: 'Category', type: 'text' },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Mesh Objects', color: '#9e9e9e', icon: '◇', order: 20 },
  hiddenFromToolbar: true,  // No GLB upload flow yet — meshes only arrive via Revit import / AI tools.
  renderZIndex: 5,

  geometry(el: CanonicalElement, _ctx: GeometryContext): MeshFacts | null {
    if (el.geometry !== 'point') return null;
    const p = el as PointElement;
    return {
      id: p.id,
      position: p.position,
      width: p.width,
      height: p.height,
      rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
    };
  },

  draw2D(facts): ReactNode {
    return (
      <g data-id={facts.id}
        transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`}>
        <rect
          x={-facts.width / 2} y={-facts.height / 2}
          width={facts.width} height={facts.height}
          fill="rgba(100,100,200,0.08)"
          stroke="#7c8aad" strokeWidth={0.02}
          strokeDasharray="0.1 0.06"
        />
      </g>
    );
  },

  draw3D(): ReactNode {
    // The 3D mesh load (when attrs.mesh_file is set) is handled by FloorGroup's
    // separate MeshInstances Suspense branch — not via this module.
    return null;
  },

  bbox(facts) {
    return {
      x: facts.position.x - facts.width / 2,
      y: facts.position.y - facts.height / 2,
      w: facts.width, h: facts.height,
    };
  },
};

registerElement(meshModule);
