import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { createProfile } from '../three/primitives/profiles.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_GRADE_FIELD, MATERIAL_OPTIONS, SHAPE_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';
import { resolveSection } from '../families/sections/index.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { PlanTag, tagText } from './_planTag.tsx';
import type { SectionFamily, SectionParams } from '../families/sections/index.ts';

const DEFAULT_HEIGHT = 3.0;
const OUTLINE_WIDTH = 0.02;  // world meters; constant regardless of column size
const CROSS_WIDTH = 0.015;
const CROSS_MARGIN = 0.9;    // X stays inside the column outline with a 10% margin

/** Cut structural section: solid fill, as structural plans draw columns. */
function structuralColumnFill(material: string): string {
  const m = (material || '').toLowerCase();
  if (m.includes('steel') || m.includes('metal')) return '#3d5266';
  if (m.includes('wood') || m.includes('clt')) return '#8a6a45';
  return '#4d4d4d';
}

function columnFill(material: string): string {
  const m = (material || '').toLowerCase();
  if (m.includes('concrete')) return '#d4d4d4';
  if (m.includes('steel') || m.includes('metal')) return '#c8d4e0';
  if (m.includes('wood') || m.includes('clt')) return '#d8c0a0';
  return '#e0e0e0';
}

export interface ColumnFacts {
  id: string;
  position: Point;
  rotationDeg: number;
  /** Resolved section family + params — drives both 2D outline and 3D shape. */
  section: { family: SectionFamily; params: SectionParams };
  material: string;
  baseY: number;
  extrudeHeight: number;  // 3D extrusion height
  number: string;
}

function buildColumnModule(table: string, defaults: Record<string, string>, layerStyle: any, shapeOptions = SHAPE_OPTIONS): ElementModule<ColumnFacts> {
  const structural = table === 'structure_column';
  return {
    table,
    discipline: table.startsWith('structure') ? 'structure' : 'architecture',
    archetype: 'point',
    prefix: table === 'structure_column' ? 'sc' : 'c',
    hasVerticalSpan: true,
    csvHeaders: [
      'number', 'base_offset', 'top_level_id', 'top_offset', 'material',
      'shape', 'size_x', 'size_y', 'flange', 'web', 'thickness', 'rotation',
      ...(structural ? ['material_grade'] : []),
    ],
    defaults,
    drawingFields: [
      { key: 'shape', label: 'Shape', type: 'select', options: shapeOptions },
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'flange', label: 'Flange Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'web', label: 'Web Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', step: 15 },
      { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
      ...(structural ? [MATERIAL_GRADE_FIELD] : []),
      BASE_OFFSET_FIELD,
    ],
    propertyFields: [],
    layerStyle,
    renderZIndex: structural ? 51 : 50,

    geometry(el: CanonicalElement, ctx: GeometryContext): ColumnFacts | null {
      if (el.geometry !== 'point') return null;
      const p = el as PointElement;
      // Resolve section family from `shape` + raw attrs. Backfill size_x/size_y
      // from the PointElement footprint when missing so legacy data still works.
      const attrsForSection: Record<string, string> = {
        ...p.attrs,
        size_x: p.attrs.size_x || String(p.width || 0.3),
        size_y: p.attrs.size_y || String(p.height || p.width || 0.3),
      };
      const section = resolveSection(p.attrs.shape || 'rect', attrsForSection);
      // Blank top_level_id = the level above (spec vertical_span), same rule as
      // walls and the IFC export — not a fixed 3 m.
      const { height: extrudeHeight, baseOffset } = resolveHeight(p.attrs, ctx.levelElevation, ctx.levelElevations, DEFAULT_HEIGHT);
      return {
        id: p.id,
        position: p.position,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        section,
        material: p.attrs.material || defaults.material,
        baseY: ctx.levelElevation + baseOffset,
        extrudeHeight,
        number: tagText(p.attrs),
      };
    },

    draw2D(facts, drawCtx): ReactNode {
      const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#333');
      const transform = `translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`;
      const { family, params } = facts.section;
      const bb = family.bbox(params);
      const hw = bb.w / 2;
      const hh = bb.d / 2;
      const tag = drawCtx.showNumbers && facts.number ? (
        <PlanTag x={facts.position.x + Math.max(hw, hh) + 0.25} y={facts.position.y + Math.max(hw, hh) + 0.15}
          text={facts.number} color={structural ? '#333' : '#555'} />
      ) : null;

      // Structural columns are cut by the plan: a solid section, the real outline.
      if (structural) {
        const fill = structuralColumnFill(facts.material);
        const body = family.id === 'round'
          ? <ellipse cx={0} cy={0} rx={hw} ry={hh} fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
          : <polygon points={family.outline2D(params).map(pt => `${pt.x},${pt.y}`).join(' ')}
              fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />;
        return (
          <g data-id={facts.id}>
            <g transform={transform}>{body}</g>
            {tag}
          </g>
        );
      }

      const fill = columnFill(facts.material);
      // Round: ellipse + X (inscribed in ellipse).
      if (family.id === 'round') {
        const xx = hw * Math.SQRT1_2 * CROSS_MARGIN;
        const yy = hh * Math.SQRT1_2 * CROSS_MARGIN;
        return (
          <g data-id={facts.id}>
            <g transform={transform}>
              <ellipse cx={0} cy={0} rx={hw} ry={hh} fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
              <line x1={-xx} y1={-yy} x2={xx} y2={yy} stroke={stroke} strokeWidth={CROSS_WIDTH} />
              <line x1={xx} y1={-yy} x2={-xx} y2={yy} stroke={stroke} strokeWidth={CROSS_WIDTH} />
            </g>
            {tag}
          </g>
        );
      }
      // Rect: outline + diagonal X (standard plan symbol).
      if (family.id === 'rect') {
        return (
          <g data-id={facts.id}>
            <g transform={transform}>
              <rect x={-hw} y={-hh} width={bb.w} height={bb.d}
                fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
              <line x1={-hw} y1={-hh} x2={hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
              <line x1={hw} y1={-hh} x2={-hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
            </g>
            {tag}
          </g>
        );
      }
      // Other sections (I/T/L/C/cross): render the actual outline.
      const points = family.outline2D(params).map(pt => `${pt.x},${pt.y}`).join(' ');
      return (
        <g data-id={facts.id}>
          <g transform={transform}>
            <polygon points={points} fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
          </g>
          {tag}
        </g>
      );
    },

    draw3D(facts, drawCtx): ReactNode {
      const profile = facts.section.family.shape3D(facts.section.params);
      const shape = createProfile(profile);
      const geo = new ExtrudeGeometry(shape, { depth: facts.extrudeHeight, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);

      const material = getBimMaterial(resolveBimMaterial(facts.material, table));
      const isHL = drawCtx.selected || drawCtx.hovered;
      // three.js rotation.y = θ turns plan +X to (cos θ, sin θ): spec rotation is CCW.
      const rotY = (facts.rotationDeg * Math.PI) / 180;
      return (
        <mesh
          geometry={geo}
          position={[facts.position.x, facts.baseY, -facts.position.y]}
          rotation={[0, rotY, 0]}
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
      const bb = facts.section.family.bbox(facts.section.params);
      return {
        x: facts.position.x - bb.w / 2,
        y: facts.position.y - bb.d / 2,
        w: bb.w, h: bb.d,
      };
    },

    selectionHandles(facts, el) {
      // Round columns have a single radius parameter — the bbox-4-corner
      // default would let the user stretch them into ellipses. Expose
      // center + one edge handle instead. Rectangular + structural sections
      // (I / T / L / C / cross) fall through to the default bbox handles
      // until each gets its own per-parameter expression.
      if (el.geometry !== 'point') return undefined;
      if (facts.section.family.id !== 'round') return undefined;
      const c = facts.position;
      const r = el.width / 2;
      return [
        {
          id: 'center', position: c, cursor: 'move',
          onDrag(snapped) { return { position: snapped }; },
        },
        {
          id: 'radius',
          position: { x: c.x + r, y: c.y },
          cursor: 'ew-resize',
          onDrag(snapped, _ds, snapshot) {
            if (snapshot.geometry !== 'point') return {};
            const dx = snapped.x - snapshot.position.x;
            const dy = snapped.y - snapshot.position.y;
            const newD = Math.max(0.05, 2 * Math.sqrt(dx * dx + dy * dy));
            // applyResize syncs attrs.size_x / size_y automatically when
            // width / height change; no need to mutate attrs here.
            return { width: newD, height: newD };
          },
        },
      ];
    },
  };
}

export const columnModule = buildColumnModule('column', {
  base_offset: '0', top_level_id: '', top_offset: '0', material: 'concrete',
  shape: 'rect', size_x: '0.3', size_y: '0.3', rotation: '0',
}, { displayName: 'Columns', color: '#2d2d2d', icon: '■', order: 3 });

export const structureColumnModule: ElementModule<ColumnFacts> = {
  ...buildColumnModule('structure_column', {
    base_offset: '0', top_level_id: '', top_offset: '0', material: 'steel',
    shape: 'rect', size_x: '0.3', size_y: '0.3', rotation: '0',
  }, { displayName: 'Str. Columns', color: '#5c3d2e', icon: '■', order: 4 }, STRUCTURAL_SHAPE_OPTIONS),
  toolbarVariants: [
    { id: 'single', label: 'layer.structure_column', icon: '■', iconName: 'structure_column', placementType: 'free_point' },
    // Drag a box over the grid (or click a crossing): a column at every crossing.
    { id: 'at_grids', label: 'layer.columns_at_grids', icon: '┼', iconName: 'grid_columns', placementType: 'region' },
  ],
};

registerElement(columnModule);
registerElement(structureColumnModule);
