import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { createProfile } from '../three/primitives/profiles.ts';
import { framingMemberMesh } from '../three/utils/memberAxis.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_GRADE_FIELD, MATERIAL_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';
import { columnFootprints, trimAtColumns } from './_framing.ts';
import { PlanTag, tagText } from './_planTag.tsx';
import { BEAM_SPACING_KEY, BEAM_SPAN_KEY } from '../model/structuralLayout.ts';
import { resolveSection } from '../families/sections/index.ts';
import type { SectionFamily, SectionParams } from '../families/sections/index.ts';

export interface BeamFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  section: { family: SectionFamily; params: SectionParams };
  baseY: number;
  material: string;
  /** Plan-view rectangular strip footprint (width = section bbox width),
   *  trimmed where the beam ends inside a column (drawn to the column face). */
  footprint2D: Point[];
  number: string;
}

/** Plan strip of a framing member between parameters t0..t1 of start→end. */
export function framingStrip(start: Point, end: Point, planWidth: number, t0 = 0, t1 = 1): Point[] {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const hw = planWidth / 2;
  const a = { x: start.x + dx * t0, y: start.y + dy * t0 };
  const b = { x: start.x + dx * t1, y: start.y + dy * t1 };
  return [
    { x: a.x + nx * hw, y: a.y + ny * hw },
    { x: b.x + nx * hw, y: b.y + ny * hw },
    { x: b.x - nx * hw, y: b.y - ny * hw },
    { x: a.x - nx * hw, y: a.y - ny * hw },
  ];
}

/**
 * Plan drawing of a beam / brace: a dashed double line (the member is under
 * the slab, below the cut plane), stopping at column faces, with an optional
 * mark along it.
 */
export function framingDraw2D(
  facts: { id: string; start: Point; end: Point; footprint2D: Point[]; number: string },
  selected: boolean,
  hovered: boolean,
  showNumbers: boolean | undefined,
): ReactNode {
  const stroke = selected ? '#3a7bff' : (hovered ? '#06b6d4' : '#6d4c41');
  const [a, b, c, d] = facts.footprint2D;
  const angle = Math.atan2(facts.end.y - facts.start.y, facts.end.x - facts.start.x) * 180 / Math.PI;
  const mid = { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
  const dash = '0.18 0.09';
  return (
    <g data-id={facts.id}>
      {/* Transparent body: keeps the whole strip clickable. */}
      <polygon points={facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ')}
        fill={selected ? 'rgba(58,123,255,0.10)' : 'transparent'} stroke="none" />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={0.02} strokeDasharray={dash} />
      <line x1={c.x} y1={c.y} x2={d.x} y2={d.y} stroke={stroke} strokeWidth={0.02} strokeDasharray={dash} />
      <line x1={a.x} y1={a.y} x2={d.x} y2={d.y} stroke={stroke} strokeWidth={0.015} />
      <line x1={b.x} y1={b.y} x2={c.x} y2={c.y} stroke={stroke} strokeWidth={0.015} />
      {showNumbers && facts.number && (
        <PlanTag x={mid.x} y={mid.y} text={facts.number} color={stroke} angleDeg={angle} size={0.24} />
      )}
    </g>
  );
}

export const beamModule: ElementModule<BeamFacts> = {
  table: 'beam',
  discipline: 'structure',
  archetype: 'spatial-line',
  prefix: 'bm',
  csvHeaders: [
    'number', 'base_offset', 'start_z', 'end_z',
    'shape', 'size_x', 'size_y', 'flange', 'web', 'thickness', 'material', 'material_grade',
  ],
  // Beam z is its TOP, relative to the level: 0 = flush with this level's
  // floor (the Revit / template convention), whatever the storey height.
  defaults: { base_offset: '0', start_z: '0', end_z: '0', shape: 'rect', size_x: '0.3', size_y: '0.5', material: 'steel' },
  drawingFields: [
    { key: 'shape', label: 'Shape', type: 'select', options: STRUCTURAL_SHAPE_OPTIONS },
    { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
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
  layerStyle: { displayName: 'Beams', color: '#8d6e63', icon: '━', order: 16 },
  toolbarVariants: [
    { id: 'single', label: 'layer.beam', icon: '━', iconName: 'beam', placementType: 'spatial_line' },
    // Drag a box (or click a grid bay): beams between neighbouring columns.
    {
      id: 'between_columns', label: 'layer.beams_between_columns', icon: '╋', iconName: 'beams_between', placementType: 'region',
      fields: ['shape', 'size_x', 'size_y', 'start_z', 'end_z', 'material'],
    },
    // Click a grid bay (or drag a box): parallel infill beams at a spacing.
    {
      id: 'beam_system', label: 'layer.beam_system', icon: '▥', iconName: 'beam_system', placementType: 'region',
      defaults: { size_x: '0.25', size_y: '0.45', [BEAM_SPACING_KEY]: '2', [BEAM_SPAN_KEY]: 'short' },
      fields: ['shape', 'size_x', 'size_y', 'start_z', 'end_z', 'material'],
      extraFields: [
        { key: BEAM_SPACING_KEY, label: 'Spacing', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
        { key: BEAM_SPAN_KEY, label: 'Span', type: 'select', options: [
          { value: 'short', label: 'Short Span' }, { value: 'long', label: 'Long Span' },
        ] },
      ],
    },
  ],
  // Under walls and columns: in plan the beam sits below the cut, columns are cut.
  renderZIndex: 33,

  geometry(el: CanonicalElement, ctx: GeometryContext): BeamFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
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
    const section = resolveSection(ln.attrs.shape || 'rect', ln.attrs);
    // 2D footprint: rectangle in plan view, width = section's plan-view extent,
    // stopping at the faces of the columns the beam frames into.
    const planWidth = section.family.bbox(section.params).w;
    const [t0, t1] = trimAtColumns(ln.start, ln.end, columnFootprints(ctx));
    const footprint2D = framingStrip(ln.start, ln.end, planWidth, t0, t1);
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
    // Section extruded along the (possibly sloped) beam line, which runs along
    // the section's top edge: beam z = top of the beam (Revit export convention).
    const shape = createProfile(facts.section.family.shape3D(facts.section.params));
    const m = framingMemberMesh(shape, facts.start, facts.end, facts.startZ, facts.endZ, facts.baseY);
    if (!m) return null;

    const material = getBimMaterial(resolveBimMaterial(facts.material, 'beam'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        geometry={m.geometry}
        position={m.position}
        quaternion={m.quaternion}
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
