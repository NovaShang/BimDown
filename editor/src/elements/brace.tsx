/**
 * Brace — spatial-line archetype, structure discipline.
 * Re-uses beam's facts/draw shape with brace-specific defaults.
 */
import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { createProfile } from '../three/primitives/profiles.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';
import { resolveSection } from '../families/sections/index.ts';
import type { SectionFamily, SectionParams } from '../families/sections/index.ts';

export interface BraceFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  section: { family: SectionFamily; params: SectionParams };
  baseY: number;
  material: string;
  footprint2D: Point[];
}

export const braceModule: ElementModule<BraceFacts> = {
  table: 'brace',
  discipline: 'structure',
  archetype: 'spatial-line',
  prefix: 'br',
  csvHeaders: [
    'number', 'base_offset', 'start_z', 'end_z',
    'shape', 'size_x', 'size_y', 'flange', 'web', 'thickness', 'material',
  ],
  defaults: { base_offset: '0', start_z: '0', end_z: '3', shape: 'rect', size_x: '0.2', size_y: '0.2', material: 'steel' },
  drawingFields: [
    { key: 'shape', label: 'Shape', type: 'select', options: STRUCTURAL_SHAPE_OPTIONS },
    { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'flange', label: 'Flange Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
    { key: 'web', label: 'Web Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
    { key: 'start_z', label: 'Start Z', type: 'number', unit: 'm', step: 0.1 },
    { key: 'end_z', label: 'End Z', type: 'number', unit: 'm', step: 0.1 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Braces', color: '#8d6e63', icon: '╲', order: 17 },
  renderZIndex: 71,
  supportsArc: false, // structural braces are straight members, not curves

  geometry(el: CanonicalElement, ctx: GeometryContext): BraceFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
    let startZ = baseOffset, endZ = baseOffset;
    if (el.geometry === 'spatial_line') {
      const sp = el as SpatialLineElement;
      startZ = sp.startZ; endZ = sp.endZ;
    } else {
      startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
      endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
    }
    const section = resolveSection(ln.attrs.shape || 'rect', ln.attrs);
    const planWidth = section.family.bbox(section.params).w;

    // 2D footprint: even for pure vertical brace (dx=dy=0), give a small marker.
    let footprint2D: Point[];
    if (len < 0.001) {
      const r = planWidth / 2;
      footprint2D = [
        { x: ln.start.x - r, y: ln.start.y - r },
        { x: ln.start.x + r, y: ln.start.y - r },
        { x: ln.start.x + r, y: ln.start.y + r },
        { x: ln.start.x - r, y: ln.start.y + r },
      ];
    } else {
      const nx = -dy / len, ny = dx / len;
      const hw = planWidth / 2;
      footprint2D = [
        { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
        { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
        { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
        { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
      ];
    }
    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      startZ, endZ,
      section,
      baseY: ctx.levelElevation,
      material: ln.attrs.material || 'steel',
      footprint2D,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
    const fill = facts.material.toLowerCase().includes('concrete') ? '#d4d4d4' : '#e8e8e8';
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={0.02} data-id={facts.id} />;
  },

  draw3D(facts, drawCtx): ReactNode {
    const dx = facts.end.x - facts.start.x;
    const dy = facts.end.y - facts.start.y;
    const horLen = Math.sqrt(dx * dx + dy * dy);
    if (horLen < 0.001) return null;
    const profile = facts.section.family.shape3D(facts.section.params);
    const shape = createProfile(profile);
    const geo = new ExtrudeGeometry(shape, { depth: horLen, bevelEnabled: false });
    const angleY = Math.atan2(-dy, dx);
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'brace'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const avgZ = (facts.startZ + facts.endZ) / 2;
    return (
      <mesh
        geometry={geo}
        position={[facts.start.x, facts.baseY + avgZ, -facts.start.y]}
        rotation={[0, angleY, 0]}
        material={isHL ? undefined : material}
        castShadow receiveShadow
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

registerElement(braceModule);
