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
import { BASE_OFFSET_FIELD, STAIR_TYPE_OPTIONS } from './_options.ts';

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
  csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'start_z', 'end_z', 'width', 'step_count', 'stair_type'],
  defaults: {
    base_offset: '0', top_level_id: '', top_offset: '0',
    start_z: '0', end_z: '3', width: '1.2', step_count: '18', stair_type: 'straight',
  },
  drawingFields: [
    { key: 'stair_type', label: 'Type', type: 'select', options: STAIR_TYPE_OPTIONS },
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'step_count', label: 'Steps', type: 'number', min: 1, step: 1 },
    BASE_OFFSET_FIELD,
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

    // Tread lines: (stepCount-1) lines perpendicular to the stair axis.
    const ux = (facts.end.x - facts.start.x) / facts.horLen;
    const uy = (facts.end.y - facts.start.y) / facts.horLen;
    const nx = -uy, ny = ux;
    const hw = facts.width / 2;
    const treadDepth = facts.horLen / facts.stepCount;
    const treadLines: ReactNode[] = [];
    for (let i = 1; i < facts.stepCount; i++) {
      const t = i * treadDepth;
      const cxA = facts.start.x + ux * t;
      const cyA = facts.start.y + uy * t;
      treadLines.push(
        <line key={i}
          x1={cxA + nx * hw} y1={cyA + ny * hw}
          x2={cxA - nx * hw} y2={cyA - ny * hw}
          stroke={stroke} strokeWidth={0.015} />,
      );
    }

    // UP arrow along the stair axis: shaft + triangular head, plus "UP" label.
    const goingUp = facts.endZ > facts.startZ;
    const arrowStart = goingUp ? 0.2 : 0.8;
    const arrowEnd = goingUp ? 0.8 : 0.2;
    const ax0 = facts.start.x + ux * facts.horLen * arrowStart;
    const ay0 = facts.start.y + uy * facts.horLen * arrowStart;
    const ax1 = facts.start.x + ux * facts.horLen * arrowEnd;
    const ay1 = facts.start.y + uy * facts.horLen * arrowEnd;
    const headSize = Math.min(facts.width * 0.4, treadDepth * 1.5);
    const dir = goingUp ? 1 : -1;
    const back = { x: ax1 - ux * headSize * dir, y: ay1 - uy * headSize * dir };
    const headPts = `${ax1},${ay1} ${back.x + nx * headSize * 0.4},${back.y + ny * headSize * 0.4} ${back.x - nx * headSize * 0.4},${back.y - ny * headSize * 0.4}`;
    const labelPos = { x: facts.start.x + ux * facts.horLen * 0.5, y: facts.start.y + uy * facts.horLen * 0.5 };

    return (
      <g data-id={facts.id}>
        <polygon points={points} fill="rgba(123,104,238,0.10)" stroke={stroke} strokeWidth={0.025} />
        {treadLines}
        <line x1={ax0} y1={ay0} x2={ax1} y2={ay1} stroke={stroke} strokeWidth={0.025} />
        <polygon points={headPts} fill={stroke} stroke="none" />
        <text
          x={labelPos.x} y={labelPos.y + 0.3}
          fontSize={0.28} fontFamily="Inter, sans-serif" fontWeight={600}
          fill={stroke} textAnchor="middle" dominantBaseline="central"
          transform={`translate(${labelPos.x},${labelPos.y + 0.3}) scale(1,-1) translate(${-labelPos.x},${-(labelPos.y + 0.3)})`}
        >
          UP
        </text>
      </g>
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
