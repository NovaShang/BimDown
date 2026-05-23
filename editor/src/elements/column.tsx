import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { createProfile, shapeFromAttrs } from '../three/primitives/profiles.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, SHAPE_OPTIONS, STRUCTURAL_SHAPE_OPTIONS } from './_options.ts';

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
  width: number;
  height: number;     // 2D footprint depth
  rotationDeg: number;
  shape: string;      // rect | round | i | t | l | c | cross
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
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'shape', 'size_x', 'size_y', 'rotation'],
    defaults,
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: shapeOptions },
      { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
      BASE_OFFSET_FIELD,
    ],
    propertyFields: [],
    layerStyle,
    renderZIndex: table === 'structure_column' ? 51 : 50,

    geometry(el: CanonicalElement, ctx: GeometryContext): ColumnFacts | null {
      if (el.geometry !== 'point') return null;
      const p = el as PointElement;
      const sizeX = parseFloat(p.attrs.size_x || '0') || p.width || 0.3;
      const sizeY = parseFloat(p.attrs.size_y || '0') || p.height || sizeX;
      const { height: extrudeHeight, baseOffset } = resolveLevelHeight(p.attrs, ctx.levelElevation, ctx.levelElevations);
      return {
        id: p.id,
        position: p.position,
        width: sizeX,
        height: sizeY,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        shape: p.attrs.shape || 'rect',
        material: p.attrs.material || defaults.material,
        baseY: ctx.levelElevation + baseOffset,
        extrudeHeight,
      };
    },

    draw2D(facts, drawCtx): ReactNode {
      const fill = columnFill(facts.material);
      const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#333');
      const hw = facts.width / 2;
      const hh = facts.height / 2;
      const transform = `translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`;

      if (facts.shape === 'round') {
        // X must fit inside the ellipse, not the bounding box. The largest
        // inscribed rectangle has corners at (rx·√½, ry·√½); the margin keeps
        // the cross visibly inside the outline.
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
      return (
        <g data-id={facts.id} transform={transform}>
          <rect x={-hw} y={-hh} width={facts.width} height={facts.height}
            fill={fill} stroke={stroke} strokeWidth={OUTLINE_WIDTH} />
          <line x1={-hw} y1={-hh} x2={hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
          <line x1={hw} y1={-hh} x2={-hw} y2={hh} stroke={stroke} strokeWidth={CROSS_WIDTH} />
        </g>
      );
    },

    draw3D(facts, drawCtx): ReactNode {
      const profile = shapeFromAttrs(facts.shape, facts.width, facts.height);
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
      const hw = facts.width / 2;
      const hh = facts.height / 2;
      return { x: facts.position.x - hw, y: facts.position.y - hh, w: facts.width, h: facts.height };
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
