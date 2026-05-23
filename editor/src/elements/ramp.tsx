/**
 * Ramp — spatial-line archetype, architecture discipline.
 * 2D: filled rectangle along ramp axis.  3D: tilted box (approximation).
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';

const RAMP_THICKNESS = 0.15;

export interface RampFacts {
  id: string;
  start: Point;
  end: Point;
  width: number;
  startZ: number;
  endZ: number;
  length: number;
  angle: number;       // around Y in world space
  material: string;
  footprint2D: Point[];
}

export const rampModule: ElementModule<RampFacts> = {
  table: 'ramp',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'rp',
  csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'width'],
  defaults: { base_offset: '0', start_z: '0', end_z: '3', width: '1.2' },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'start_z', label: 'Start Z', type: 'number', unit: 'm', step: 0.1 },
    { key: 'end_z', label: 'End Z', type: 'number', unit: 'm', step: 0.1 },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Ramps', color: '#7b68ee', icon: '⟋', order: 9.1 },
  renderZIndex: 31,

  geometry(el: CanonicalElement, _ctx: GeometryContext): RampFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
    const width = parseFloat(ln.attrs.width || '1.2') || 1.2;
    const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
    let startZ = baseOffset, endZ = baseOffset;
    if (el.geometry === 'spatial_line') {
      const sp = el as SpatialLineElement;
      startZ = sp.startZ; endZ = sp.endZ;
    } else {
      startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
      endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
    }
    const nx = -dy / len, ny = dx / len;
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
      width,
      startZ, endZ,
      length: len,
      angle: Math.atan2(dy, dx),
      material: ln.attrs.material || 'concrete',
      footprint2D,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    // Up arrow along ramp axis to show slope direction, plus "UP" label.
    const goingUp = facts.endZ > facts.startZ;
    const dx = facts.end.x - facts.start.x;
    const dy = facts.end.y - facts.start.y;
    const ux = dx / facts.length, uy = dy / facts.length;
    const nx = -uy, ny = ux;
    const arrowFromT = goingUp ? 0.2 : 0.8;
    const arrowToT = goingUp ? 0.8 : 0.2;
    const dir = goingUp ? 1 : -1;
    const headSize = Math.min(facts.width * 0.4, facts.length * 0.1);
    const ax0 = facts.start.x + ux * facts.length * arrowFromT;
    const ay0 = facts.start.y + uy * facts.length * arrowFromT;
    const ax1 = facts.start.x + ux * facts.length * arrowToT;
    const ay1 = facts.start.y + uy * facts.length * arrowToT;
    const back = { x: ax1 - ux * headSize * dir, y: ay1 - uy * headSize * dir };
    const headPts = `${ax1},${ay1} ${back.x + nx * headSize * 0.4},${back.y + ny * headSize * 0.4} ${back.x - nx * headSize * 0.4},${back.y - ny * headSize * 0.4}`;
    const labelPos = { x: facts.start.x + ux * facts.length * 0.5, y: facts.start.y + uy * facts.length * 0.5 };
    const slopePct = facts.length > 0.01 ? Math.abs((facts.endZ - facts.startZ) / facts.length) * 100 : 0;
    return (
      <g data-id={facts.id}>
        <polygon points={points} fill="#e8e8e8" stroke={stroke} strokeWidth={0.02} />
        <line x1={ax0} y1={ay0} x2={ax1} y2={ay1} stroke={stroke} strokeWidth={0.025} />
        <polygon points={headPts} fill={stroke} stroke="none" />
        {slopePct > 0.01 && (
          <text
            x={labelPos.x} y={labelPos.y + 0.3}
            fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={500}
            fill={stroke} textAnchor="middle" dominantBaseline="central"
            transform={`translate(${labelPos.x},${labelPos.y + 0.3}) scale(1,-1) translate(${-labelPos.x},${-(labelPos.y + 0.3)})`}
          >
            {`UP ${slopePct.toFixed(1)}%`}
          </text>
        )}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    // Box at min(startZ, endZ); V1 ramp builder uses the same simplification.
    const cx = (facts.start.x + facts.end.x) / 2;
    const cySvg = (facts.start.y + facts.end.y) / 2;
    const baseY = Math.min(facts.startZ, facts.endZ);
    const cy = baseY + RAMP_THICKNESS / 2;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'ramp'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        position={[cx, cy, -cySvg]}
        rotation={[0, facts.angle, 0]}
        scale={[facts.length, RAMP_THICKNESS, facts.width]}
        material={isHL ? undefined : material}
        userData={{ elementId: facts.id }}
      >
        <boxGeometry args={[1, 1, 1]} />
        {isHL && (
          <meshStandardMaterial attach="material" color="#06b6d4"
            transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
        )}
      </mesh>
    );
  },
};

registerElement(rampModule);
