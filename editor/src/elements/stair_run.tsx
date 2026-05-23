/**
 * Stair run — one straight flight hosted on a parent stair. Multi-run stairs
 * (L / U / switchback) are formed by combining a parent stair with one or
 * more stair_run + stair_landing rows.
 *
 * 2D: same tread-strip + UP-arrow symbol as the parent stair.
 * 3D: array of tread boxes between startZ and endZ.
 *
 * Geometry-wise this is just a spatial-line element with its own width and
 * step_count; the parent stair carries the overall metadata.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type {
  CanonicalElement, LineElement, SpatialLineElement, Point,
} from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';

const TREAD_THICKNESS = 0.03;

export interface StairRunFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  baseY: number;
  material: string;
  footprint2D: Point[];
  angle: number;
  horLen: number;
}

export const stairRunModule: ElementModule<StairRunFacts> = {
  table: 'stair_run',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'sr',
  hostType: 'stair',
  hostTables: ['stair'],
  csvHeaders: ['number', 'base_offset', 'host_id', 'start_z', 'end_z', 'width', 'step_count'],
  defaults: {
    base_offset: '0', host_id: '',
    start_z: '0', end_z: '3', width: '1.2', step_count: '18',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'step_count', label: 'Steps', type: 'number', min: 1, step: 1 },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Stair Runs', color: '#7b68ee', icon: '⊟', order: 9.02 },
  renderZIndex: 30,

  geometry(el: CanonicalElement, ctx: GeometryContext): StairRunFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const horLen = Math.sqrt(dx * dx + dy * dy);
    if (horLen < 0.001) return null;

    let startZ = 0, endZ = 3;
    if (el.geometry === 'spatial_line') {
      const sp = el as SpatialLineElement;
      startZ = sp.startZ; endZ = sp.endZ;
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
      { x: ln.end.x + nx * hw, y: ln.end.y + ny * hw },
      { x: ln.end.x - nx * hw, y: ln.end.y - ny * hw },
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
    // No UP label per run (the parent stair already carries it); just treads.
    return (
      <g data-id={facts.id}>
        <polygon points={points} fill="rgba(123,104,238,0.10)" stroke={stroke} strokeWidth={0.025} />
        {treadLines}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const treadDepth = facts.horLen / facts.stepCount;
    const rise = (facts.endZ - facts.startZ) / facts.stepCount;
    const ux = (facts.end.x - facts.start.x) / facts.horLen;
    const uy = (facts.end.y - facts.start.y) / facts.horLen;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair_run'));
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

  bbox(facts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.footprint2D) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(stairRunModule);
