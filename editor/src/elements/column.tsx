import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { createProfile } from '../three/primitives/profiles.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, SHAPE_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';
import { resolveSection } from '../families/sections/index.ts';
import type { SectionFamily, SectionParams } from '../families/sections/index.ts';

const DEFAULT_HEIGHT = 3.0;
const OUTLINE_WIDTH = 0.02;  // world meters; constant regardless of column size
const CROSS_WIDTH = 0.015;
const CROSS_MARGIN = 0.9;    // X stays inside the column outline with a 10% margin

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
}

function resolveLevelHeight(
  attrs: Record<string, string>,
  levelElevation: number,
  levelElevations: Map<string, number>,
): { height: number; baseOffset: number } {
  const baseOffset = parseFloat(attrs.base_offset || '0') || 0;
  const topLevelId = attrs.top_level_id;
  if (topLevelId && levelElevations.has(topLevelId)) {
    const topElevation = levelElevations.get(topLevelId)!;
    const topOffset = parseFloat(attrs.top_offset || '0') || 0;
    const top = topElevation + topOffset;
    const base = levelElevation + baseOffset;
    return { height: Math.max(0.01, top - base), baseOffset };
  }
  return { height: DEFAULT_HEIGHT, baseOffset };
}

function buildColumnModule(table: string, defaults: Record<string, string>, layerStyle: any, shapeOptions = SHAPE_OPTIONS): ElementModule<ColumnFacts> {
  return {
    table,
    discipline: table.startsWith('structure') ? 'structure' : 'architecture',
    archetype: 'point',
    prefix: table === 'structure_column' ? 'sc' : 'c',
    hasVerticalSpan: true,
    csvHeaders: [
      'number', 'base_offset', 'top_level_id', 'top_offset', 'material',
      'shape', 'size_x', 'size_y', 'flange', 'web', 'thickness', 'rotation',
    ],
    defaults,
    drawingFields: [
      { key: 'shape', label: 'Shape', type: 'select', options: shapeOptions },
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'flange', label: 'Flange Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'web', label: 'Web Thk', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.002, step: 0.002 },
      { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
      BASE_OFFSET_FIELD,
    ],
    propertyFields: [],
    layerStyle,
    renderZIndex: table === 'structure_column' ? 51 : 50,

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
      const { height: extrudeHeight, baseOffset } = resolveLevelHeight(p.attrs, ctx.levelElevation, ctx.levelElevations);
      return {
        id: p.id,
        position: p.position,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        section,
        material: p.attrs.material || defaults.material,
        baseY: ctx.levelElevation + baseOffset,
        extrudeHeight,
      };
    },

    draw2D(facts, drawCtx): ReactNode {
      const fill = columnFill(facts.material);
      const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#333');
      const transform = `translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`;
      const { family, params } = facts.section;
      const bb = family.bbox(params);
      const hw = bb.w / 2;
      const hh = bb.d / 2;

      // Round: ellipse + X (inscribed in ellipse).
      if (family.id === 'round') {
        const xx = hw * Math.SQRT1_2 * CROSS_MARGIN;
        const yy = hh * Math.SQRT1_2 * CROSS_MARGIN;
        return (
          <g data-id={facts.id} transform={transform}>
            <ellipse cx={0} cy={0} rx={hw} ry={hh} fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
            <line x1={-xx} y1={-yy} x2={xx} y2={yy} stroke={stroke} strokeWidth={CROSS_WIDTH} />
            <line x1={xx} y1={-yy} x2={-xx} y2={yy} stroke={stroke} strokeWidth={CROSS_WIDTH} />
          </g>
        );
      }
      // Rect: outline + diagonal X (standard plan symbol).
      if (family.id === 'rect') {
        return (
          <g data-id={facts.id} transform={transform}>
            <rect x={-hw} y={-hh} width={bb.w} height={bb.d}
              fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
            <line x1={-hw} y1={-hh} x2={hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
            <line x1={hw} y1={-hh} x2={-hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
          </g>
        );
      }
      // Structural sections (I/T/L/C/cross): render the actual outline.
      const points = family.outline2D(params).map(pt => `${pt.x},${pt.y}`).join(' ');
      return (
        <g data-id={facts.id} transform={transform}>
          <polygon points={points} fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
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
      const rotY = -(facts.rotationDeg * Math.PI) / 180;
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
  };
}

export const columnModule = buildColumnModule('column', {
  base_offset: '0', top_level_id: '', top_offset: '0', material: 'concrete',
  shape: 'rect', size_x: '0.3', size_y: '0.3', rotation: '0',
}, { displayName: 'Columns', color: '#2d2d2d', icon: '■', order: 3 });

export const structureColumnModule = buildColumnModule('structure_column', {
  base_offset: '0', top_level_id: '', top_offset: '0', material: 'steel',
  shape: 'rect', size_x: '0.3', size_y: '0.3', rotation: '0',
}, { displayName: 'Str. Columns', color: '#5c3d2e', icon: '■', order: 4 }, STRUCTURAL_SHAPE_OPTIONS);

registerElement(columnModule);
registerElement(structureColumnModule);
