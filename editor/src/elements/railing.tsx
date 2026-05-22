/**
 * Railing — spatial-line archetype, composite element.
 * 2D: thin line (V1 parity; proper rail/baluster symbols deferred).
 * 3D: handrail box at top + array of baluster boxes along path.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type {
  CanonicalElement, LineElement, SpatialLineElement, Point,
} from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const DEFAULT_RAILING_HEIGHT = 1.0;
const BALUSTER_SPACING = 0.12;
const BALUSTER_SIZE = 0.025;
const HANDRAIL_SIZE = 0.04;

export interface RailingFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  height: number;
  baseY: number;
  material: string;
  horLen: number;
  angle: number;
}

export const railingModule: ElementModule<RailingFacts> = {
  table: 'railing',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'rl',
  csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'height'],
  defaults: { base_offset: '0', start_z: '0', end_z: '0', height: '1.0' },
  drawingFields: [
    { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Railings', color: '#546e7a', icon: '┃', order: 9.2 },
  renderZIndex: 32,

  geometry(el: CanonicalElement, ctx: GeometryContext): RailingFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const horLen = Math.sqrt(dx * dx + dy * dy);
    if (horLen < 0.001) return null;

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
    const height = parseFloat(ln.attrs.height || `${DEFAULT_RAILING_HEIGHT}`) || DEFAULT_RAILING_HEIGHT;
    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      startZ, endZ, height,
      baseY: ctx.levelElevation,
      material: ln.attrs.material || 'steel',
      horLen,
      angle: Math.atan2(dy, dx),
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#546e7a';
    return (
      <line
        x1={facts.start.x} y1={facts.start.y}
        x2={facts.end.x} y2={facts.end.y}
        stroke={stroke} strokeWidth={0.04}
        data-id={facts.id}
      />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'railing'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const highlight = isHL ? (
      <meshStandardMaterial attach="material" color="#06b6d4"
        transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
    ) : null;

    // Handrail box at top: centerline from (start.x, baseY+startZ+height, -start.y)
    // to (end.x, baseY+endZ+height, -end.y).  Box positioned at midpoint.
    const handrailMidX = (facts.start.x + facts.end.x) / 2;
    const handrailMidYSvg = (facts.start.y + facts.end.y) / 2;
    const handrailMidY = facts.baseY + (facts.startZ + facts.endZ) / 2 + facts.height;
    const handrailLen = facts.horLen; // ignoring vertical span for simplicity

    const handrail = (
      <mesh
        key="handrail"
        position={[handrailMidX, handrailMidY, -handrailMidYSvg]}
        rotation={[0, facts.angle, 0]}
        scale={[handrailLen, HANDRAIL_SIZE, HANDRAIL_SIZE]}
        material={isHL ? undefined : material}
        userData={{ elementId: facts.id }}
      >
        <boxGeometry args={[1, 1, 1]} />
        {highlight}
      </mesh>
    );

    // Balusters at even spacing along path
    const count = Math.max(2, Math.floor(facts.horLen / BALUSTER_SPACING) + 1);
    const step = facts.horLen / (count - 1);
    const ux = (facts.end.x - facts.start.x) / facts.horLen;
    const uy = (facts.end.y - facts.start.y) / facts.horLen;
    const balusters: ReactNode[] = [];
    for (let i = 0; i < count; i++) {
      const t = i * step;
      const bx = facts.start.x + ux * t;
      const bySvg = facts.start.y + uy * t;
      const lerp = count === 1 ? 0 : t / facts.horLen;
      const bz = facts.startZ + (facts.endZ - facts.startZ) * lerp;
      const cy = facts.baseY + bz + facts.height / 2;
      balusters.push(
        <mesh
          key={`b${i}`}
          position={[bx, cy, -bySvg]}
          rotation={[0, facts.angle, 0]}
          scale={[BALUSTER_SIZE, facts.height, BALUSTER_SIZE]}
          material={isHL ? undefined : material}
          userData={{ elementId: facts.id }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {highlight}
        </mesh>,
      );
    }
    return <group>{handrail}{balusters}</group>;
  },
};

registerElement(railingModule);
