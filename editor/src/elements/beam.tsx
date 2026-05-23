import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { createProfile, shapeFromAttrs } from '../three/primitives/profiles.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';

export interface BeamFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  sizeX: number;
  sizeY: number;
  shape: string;
  baseY: number;
  material: string;
  /** SVG line strip 4-corner footprint (rect cross-section projected to 2D). */
  footprint2D: Point[];
}

export const beamModule: ElementModule<BeamFacts> = {
  table: 'beam',
  discipline: 'structure',
  archetype: 'spatial-line',
  prefix: 'bm',
  csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'material'],
  defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'rect', size_x: '0.3', size_y: '0.5', material: 'steel' },
  drawingFields: [
    { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
    { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
    { key: 'start_z', label: 'Start Z', type: 'number', unit: 'm', step: 0.1 },
    { key: 'end_z', label: 'End Z', type: 'number', unit: 'm', step: 0.1 },
    { key: 'shape', label: 'Shape', type: 'select', options: STRUCTURAL_SHAPE_OPTIONS },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Beams', color: '#8d6e63', icon: '━', order: 16 },
  renderZIndex: 70,

  geometry(el: CanonicalElement, ctx: GeometryContext): BeamFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
    const sizeX = parseFloat(ln.attrs.size_x || '0.3') || 0.3;
    const sizeY = parseFloat(ln.attrs.size_y || '0.5') || 0.5;
    const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
    let startZ = baseOffset, endZ = baseOffset;
    if (el.geometry === 'spatial_line') {
      const sp = el as SpatialLineElement;
      startZ = sp.startZ;
      endZ = sp.endZ;
    } else {
      startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
      endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
    }
    // 2D footprint: rectangle of width sizeX (in plan view) along beam centerline.
    const nx = -dy / len, ny = dx / len;
    const hw = sizeX / 2;
    const footprint2D: Point[] = [
      { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
      { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
      { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
      { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
    ];
    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      startZ, endZ,
      sizeX, sizeY,
      shape: ln.attrs.shape || 'rect',
      baseY: ctx.levelElevation,
      material: ln.attrs.material || 'steel',
      footprint2D,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
    const fill = facts.material.toLowerCase().includes('concrete') ? '#d4d4d4' : '#e8e8e8';
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    return (
      <g data-id={facts.id}>
        <polygon points={points} fill={fill} stroke={stroke} strokeWidth={0.03} strokeLinejoin="miter" />
        {/* Beam centerline — common CAD convention for structural members. */}
        <line
          x1={facts.start.x} y1={facts.start.y}
          x2={facts.end.x} y2={facts.end.y}
          stroke={stroke} strokeWidth={0.015} strokeDasharray="0.2 0.08 0.04 0.08" opacity={0.7}
        />
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    // Extrude the structural cross-section profile along the beam axis.
    // Approach: orient the cross-section perpendicular to (start→end), extrude by chord length.
    // For simplicity, build via a separate transform per beam (no batching).
    const dx = facts.end.x - facts.start.x;
    const dy = facts.end.y - facts.start.y;
    const horLen = Math.sqrt(dx * dx + dy * dy);
    if (horLen < 0.001) return null;

    const profile = shapeFromAttrs(facts.shape, facts.sizeX, facts.sizeY);
    const shape = createProfile(profile);
    // Profile in XY → extrude by horLen along Z (will be rotated to align with beam axis).
    const geo = new ExtrudeGeometry(shape, { depth: horLen, bevelEnabled: false });

    // Compute rotation to align local Z with beam direction (in world XZ plane).
    const angleY = Math.atan2(-dy, dx);

    const material = getBimMaterial(resolveBimMaterial(facts.material, 'beam'));
    const isHL = drawCtx.selected || drawCtx.hovered;

    // Beam world Y: average of start_z and end_z + level elevation. Approximation
    // for sloped beams. Full path-extrusion comes later.
    const avgZ = (facts.startZ + facts.endZ) / 2;
    return (
      <mesh
        geometry={geo}
        position={[facts.start.x, facts.baseY + avgZ, -facts.start.y]}
        rotation={[0, angleY, 0]}
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
};

registerElement(beamModule);
