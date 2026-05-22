/**
 * Roof — surface archetype, supports flat/gable/hip/shed/mansard via slope.
 * Delegates 3D geometry to three/utils/roofGeometry.ts (handles pitched shapes).
 * 2D is a polygon outline; ridge lines / slope arrows are a separate concern
 * tracked in test issues for follow-up work.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement, Point } from '../model/elements.ts';
import { createRoofGeometry } from '../three/utils/roofGeometry.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { MATERIAL_OPTIONS, ROOF_TYPE_OPTIONS } from '../model/tableRegistry.ts';

const DEFAULT_THICKNESS = 0.2;

export interface RoofFacts {
  id: string;
  vertices: Point[];
  thickness: number;
  baseY: number;
  roofType: string;
  slopeDeg: number;
  material: string;
}

export const roofModule: ElementModule<RoofFacts> = {
  table: 'roof',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'ro',
  csvHeaders: ['number', 'base_offset', 'material', 'roof_type', 'slope', 'thickness'],
  defaults: { base_offset: '0', material: 'concrete', roof_type: 'flat', slope: '0', thickness: `${DEFAULT_THICKNESS}` },
  drawingFields: [
    { key: 'roof_type', label: 'Type', type: 'select', options: ROOF_TYPE_OPTIONS },
    { key: 'slope', label: 'Slope', type: 'number', unit: '°', min: 0, max: 60, step: 5 },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Roofs', color: '#8d6e63', icon: '△', order: 7.5 },
  renderZIndex: 19,

  geometry(el: CanonicalElement, ctx: GeometryContext): RoofFacts | null {
    if (el.geometry !== 'polygon') return null;
    const p = el as PolygonElement;
    if (p.vertices.length < 3) return null;
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    const thickness = parseFloat(p.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
    const slopeDeg = parseFloat(p.attrs.slope || '0') || 0;
    return {
      id: p.id,
      vertices: p.vertices,
      thickness,
      baseY: ctx.levelElevation + baseOffset,
      roofType: p.attrs.roof_type || 'flat',
      slopeDeg,
      material: p.attrs.material || 'concrete',
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    return (
      <polygon
        points={points}
        fill="rgba(141,110,99,0.05)"
        stroke={stroke}
        strokeWidth={0.025}
        data-id={facts.id}
      />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const geo = createRoofGeometry({
      kind: 'extrude',
      vertices: facts.vertices,
      baseY: facts.baseY,
      height: facts.thickness,
      roofType: facts.roofType,
      slopeDeg: facts.slopeDeg,
    });
    if (!geo) return null;

    const material = getBimMaterial(resolveBimMaterial(facts.material, 'roof'));
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
    for (const p of facts.vertices) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(roofModule);
