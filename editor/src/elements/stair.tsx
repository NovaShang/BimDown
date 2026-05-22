/**
 * Stair — spatial-line archetype, composite element.
 * 2D: filled strip along stair axis (basic; proper tread / cut-line / arrow
 *     symbols are tracked in test issues for a later pass).
 * 3D: array of tread boxes generated from start→end + step_count + Z rise.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type {
  CanonicalElement, LineElement, SpatialLineElement, Point,
} from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const TREAD_THICKNESS = 0.03;

export interface StairFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  baseY: number;          // level elevation (treads are in level-local Z)
  material: string;
  footprint2D: Point[];   // 2D plan footprint (rectangular along axis)
  angle: number;          // around Y, atan2(dy,dx)
  horLen: number;
}

export const stairModule: ElementModule<StairFacts> = {
  table: 'stair',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'st',
  hasVerticalSpan: true,
  csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'start_z', 'end_z', 'width', 'step_count'],
  defaults: {
    base_offset: '0', top_level_id: '', top_offset: '0',
    start_z: '0', end_z: '3', width: '1.2', step_count: '18',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'step_count', label: 'Steps', type: 'number', min: 1, step: 1 },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Stairs', color: '#7b68ee', icon: '⊞', order: 9 },
  renderZIndex: 30,

  geometry(el: CanonicalElement, ctx: GeometryContext): StairFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const horLen = Math.sqrt(dx * dx + dy * dy);
    if (horLen < 0.001) return null;

    let startZ = 0, endZ = 3;
    if (el.geometry === 'spatial_line') {
      const sp = el as SpatialLineElement;
      startZ = sp.startZ;
      endZ = sp.endZ;
    } else {
      startZ = parseFloat(ln.attrs.start_z || '0') || 0;
      endZ = parseFloat(ln.attrs.end_z || '3') || 3;
    }
    const width = parseFloat(ln.attrs.width || '1.2') || 1.2;
    const stepCount = Math.max(1, parseInt(ln.attrs.step_count || '18', 10) || 18);

    const nx = -dy / horLen, ny = dx / horLen;
    const hw = width / 2;
    const footprint2D: Point[] = [
      { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
      { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
      { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
      { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
    ];

    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      startZ, endZ, width, stepCount,
      baseY: ctx.levelElevation,
      material: ln.attrs.material || 'concrete',
      footprint2D,
      angle: Math.atan2(dy, dx),
      horLen,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    return (
      <polygon points={points} fill="rgba(123,104,238,0.10)" stroke={stroke} strokeWidth={0.025} data-id={facts.id} />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const treadDepth = facts.horLen / facts.stepCount;
    const rise = (facts.endZ - facts.startZ) / facts.stepCount;
    const ux = (facts.end.x - facts.start.x) / facts.horLen;
    const uy = (facts.end.y - facts.start.y) / facts.horLen;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair'));
    const isHL = drawCtx.selected || drawCtx.hovered;

    const treads: ReactNode[] = [];
    for (let i = 0; i < facts.stepCount; i++) {
      const cxAlong = (i + 0.5) * treadDepth;
      const worldX = facts.start.x + ux * cxAlong;
      const worldSvgY = facts.start.y + uy * cxAlong;
      const topZ = facts.startZ + (i + 1) * rise;
      const cy = facts.baseY + topZ - TREAD_THICKNESS / 2;
      treads.push(
        <mesh
          key={i}
          position={[worldX, cy, -worldSvgY]}
          rotation={[0, facts.angle, 0]}
          scale={[treadDepth, TREAD_THICKNESS, facts.width]}
          material={isHL ? undefined : material}
          userData={{ elementId: facts.id }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {isHL && (
            <meshStandardMaterial attach="material" color="#06b6d4"
              transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
          )}
        </mesh>,
      );
    }
    return <group>{treads}</group>;
  },
};

registerElement(stairModule);
