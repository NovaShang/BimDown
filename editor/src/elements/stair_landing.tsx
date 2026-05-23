/**
 * Stair landing — polygon platform hosted on a `stair` row. Multiple landings
 * can share the same host_id (U / W / switchback stairs).
 *
 * 2D: dashed-edge filled polygon at the landing fill color.
 * 3D: extruded slab at base_offset elevation.
 *
 * This is the lightweight first piece of the FAMILY_VISION-aligned Revit
 * Component Stair model — full stair-with-runs decomposition will follow.
 */
import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';

const DEFAULT_THICKNESS = 0.15;

export interface StairLandingFacts {
  id: string;
  vertices: Point[];
  baseY: number;
  thickness: number;
  material: string;
}

export const stairLandingModule: ElementModule<StairLandingFacts> = {
  table: 'stair_landing',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'sl_land',
  hostType: 'stair',
  hostTables: ['stair'],
  csvHeaders: ['number', 'host_id', 'base_offset', 'thickness', 'material'],
  defaults: {
    host_id: '', base_offset: '0', thickness: `${DEFAULT_THICKNESS}`, material: 'concrete',
  },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Stair Landings', color: '#a99bdc', icon: '▢', order: 9.05 },
  renderZIndex: 29,

  geometry(el: CanonicalElement, ctx: GeometryContext): StairLandingFacts | null {
    if (el.geometry !== 'polygon') return null;
    const p = el as PolygonElement;
    if (p.vertices.length < 3) return null;
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    const thickness = parseFloat(p.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
    return {
      id: p.id,
      vertices: p.vertices,
      baseY: ctx.levelElevation + baseOffset,
      thickness,
      material: p.attrs.material || 'concrete',
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    const fill = 'rgba(123,104,238,0.18)';
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    return (
      <polygon
        points={points}
        fill={fill}
        stroke={stroke}
        strokeWidth={0.025}
        strokeDasharray="0.18 0.08"
        data-id={facts.id}
      />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const shape = new Shape();
    shape.moveTo(facts.vertices[0].x, facts.vertices[0].y);
    for (let i = 1; i < facts.vertices.length; i++) {
      shape.lineTo(facts.vertices[i].x, facts.vertices[i].y);
    }
    shape.closePath();
    const geo = new ExtrudeGeometry(shape, { depth: facts.thickness, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, facts.baseY, 0);
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair_landing'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        geometry={geo}
        material={isHL ? undefined : material}
        castShadow
        receiveShadow
        userData={{ elementId: facts.id }}
      >
        {isHL && (
          <meshStandardMaterial attach="material" color="#06b6d4"
            transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
        )}
      </mesh>
    );
  },

  bbox(facts) {
    if (facts.vertices.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of facts.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(stairLandingModule);
