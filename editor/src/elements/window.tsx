import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { getBlockSvg } from '../renderers/blockLoader.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

export interface WindowFacts {
  id: string;
  start: Point;
  end: Point;
  length: number;
  angleDeg: number;
  strokeWidth: number;
  height: number;
  baseY: number;
  width: number;
  material: string;
}

const DEFAULT_HEIGHT = 1.5;
const DEFAULT_SILL = 0.9;
const WINDOW_TABLE = 'window';

export const windowModule: ElementModule<WindowFacts> = {
  table: WINDOW_TABLE,
  discipline: 'architecture',
  archetype: 'hosted',
  prefix: 'wn',
  hostType: 'wall',
  hostTables: ['wall', 'curtain_wall', 'structure_wall'],
  widthAttr: 'width',
  csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'material', 'width', 'height'],
  defaults: {
    base_offset: `${DEFAULT_SILL}`, host_id: '', position: '0.5',
    material: '', width: '1.2', height: `${DEFAULT_HEIGHT}`,
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Windows', color: '#48cae4', icon: '⊟', order: 5.5 },
  renderZIndex: 60,

  geometry(el: CanonicalElement, ctx: GeometryContext): WindowFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const w = el as LineElement;
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;

    const baseOffset = parseFloat(w.attrs.base_offset || `${DEFAULT_SILL}`);
    const height = parseFloat(w.attrs.height || `${DEFAULT_HEIGHT}`) || DEFAULT_HEIGHT;

    return {
      id: w.id,
      start: w.start,
      end: w.end,
      length: len,
      angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      strokeWidth: w.strokeWidth,
      height,
      baseY: ctx.levelElevation + baseOffset,
      width: parseFloat(w.attrs.width || '1.2') || 1.2,
      material: w.attrs.material || '',
    };
  },

  draw2D(facts): ReactNode {
    const svg = getBlockSvg('window');
    if (!svg) return null;
    const hw = facts.strokeWidth / 2;
    const transform =
      `translate(${facts.start.x},${facts.start.y}) rotate(${facts.angleDeg}) ` +
      `translate(0,${-hw}) scale(${facts.length},${facts.strokeWidth})`;
    return (
      <g data-id={facts.id} transform={transform} dangerouslySetInnerHTML={{ __html: svg }} />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const cx = (facts.start.x + facts.end.x) / 2;
    const cySvg = (facts.start.y + facts.end.y) / 2;
    const cy = facts.baseY + facts.height / 2;
    const angleRad = (facts.angleDeg * Math.PI) / 180;
    const thickness = facts.strokeWidth || 0.04;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'window'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        position={[cx, cy, -cySvg]}
        rotation={[0, angleRad, 0]}
        scale={[facts.length, facts.height, thickness]}
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

registerElement(windowModule);
