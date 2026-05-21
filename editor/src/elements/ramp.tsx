/**
 * Ramp — spatial-line archetype, architecture discipline.
 * 2D: filled rectangle along ramp axis.  3D: tilted box (approximation).
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

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
    return <polygon points={points} fill="#e8e8e8" stroke={stroke} strokeWidth={0.02} data-id={facts.id} />;
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
