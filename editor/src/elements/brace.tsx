/**
 * Brace — spatial-line archetype, structure discipline.
 * Re-uses beam's facts/draw shape with brace-specific defaults.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { createProfile } from '../three/primitives/profiles.ts';
import { framingMemberMesh } from '../three/utils/memberAxis.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_GRADE_FIELD, MATERIAL_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';
import { columnFootprints, trimAtColumns } from './_framing.ts';
import { framingDraw2D, framingStrip } from './beam.tsx';
import { tagText } from './_planTag.tsx';
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
  number: string;
}

export const braceModule: ElementModule<BraceFacts> = {
  table: 'brace',
  discipline: 'structure',
  archetype: 'spatial-line',
  prefix: 'br',
  csvHeaders: [
    'number', 'base_offset', 'start_z', 'end_z',
    'shape', 'size_x', 'size_y', 'flange', 'web', 'thickness', 'material', 'material_grade',
  ],
  defaults: { base_offset: '0', start_z: '0', end_z: '3', shape: 'rect', size_x: '0.2', size_y: '0.2', material: 'steel' },
  // A brace spans the storey: floor of this level → floor of the next.
  levelHeightDefaults: (h) => ({ end_z: String(Math.round(h * 1000) / 1000) }),
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
    MATERIAL_GRADE_FIELD,
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Braces', color: '#8d6e63', icon: '╲', order: 17 },
  renderZIndex: 34,
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
      const [t0, t1] = trimAtColumns(ln.start, ln.end, columnFootprints(ctx));
      footprint2D = framingStrip(ln.start, ln.end, planWidth, t0, t1);
    }
    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      startZ, endZ,
      section,
      baseY: ctx.levelElevation,
      material: ln.attrs.material || 'steel',
      footprint2D,
      number: tagText(ln.attrs),
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    return framingDraw2D(facts, drawCtx.selected, drawCtx.hovered, drawCtx.showNumbers);
  },

  draw3D(facts, drawCtx): ReactNode {
    // Same convention as beam: section extruded along the sloped line, line on its top edge.
    const shape = createProfile(facts.section.family.shape3D(facts.section.params));
    const m = framingMemberMesh(shape, facts.start, facts.end, facts.startZ, facts.endZ, facts.baseY);
    if (!m) return null;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'brace'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        geometry={m.geometry}
        position={m.position}
        quaternion={m.quaternion}
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
