import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { getBlockSvg } from '../renderers/blockLoader.ts';
import {
  MATERIAL_OPTIONS,
  OPERATION_OPTIONS,
  HINGE_OPTIONS,
  SWING_SIDE_OPTIONS,
} from '../model/tableRegistry.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const BLOCK_MAP: Record<string, string> = {
  single_swing: 'door_single_swing',
  double_swing: 'door_double_swing',
  sliding: 'door_sliding',
  folding: 'door_folding',
};

export interface DoorFacts {
  id: string;
  start: Point;
  end: Point;
  length: number;
  angleDeg: number;
  blockName: string;
  hingeEnd: boolean;     // true when hinge is on end (mirror X)
  swingRight: boolean;   // true → mirror Y
  height: number;
  baseY: number;
  width: number;
  thickness: number;
  material: string;
}

const DEFAULT_HEIGHT = 2.1;
const DOOR_TABLE = 'door';

export const doorModule: ElementModule<DoorFacts> = {
  table: DOOR_TABLE,
  discipline: 'architecture',
  archetype: 'hosted',
  prefix: 'd',
  hostType: 'wall',
  hostTables: ['wall', 'curtain_wall', 'structure_wall'],
  widthAttr: 'width',
  csvHeaders: [
    'number', 'base_offset', 'host_id', 'position', 'material',
    'width', 'height', 'operation', 'hinge_position', 'swing_side',
  ],
  defaults: {
    base_offset: '0', host_id: '', position: '0.5', material: '',
    width: '0.9', height: '2.1', operation: 'single_swing',
    hinge_position: 'start', swing_side: 'left',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.5, step: 0.1 },
    { key: 'operation', label: 'Type', type: 'select', options: OPERATION_OPTIONS },
    { key: 'hinge_position', label: 'Hinge', type: 'select', options: HINGE_OPTIONS },
    { key: 'swing_side', label: 'Swing', type: 'select', options: SWING_SIDE_OPTIONS },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Doors', color: '#0077b6', icon: '▭', order: 5 },
  renderZIndex: 61,

  geometry(el: CanonicalElement, ctx: GeometryContext): DoorFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const d = el as LineElement;
    const dx = d.end.x - d.start.x;
    const dy = d.end.y - d.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;

    const operation = d.attrs.operation || 'single_swing';
    const blockName = BLOCK_MAP[operation] ?? 'door_single_swing';
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const baseOffset = parseFloat(d.attrs.base_offset || '0');
    const height = parseFloat(d.attrs.height || `${DEFAULT_HEIGHT}`) || DEFAULT_HEIGHT;

    return {
      id: d.id,
      start: d.start,
      end: d.end,
      length: len,
      angleDeg,
      blockName,
      hingeEnd: d.attrs.hinge_position === 'end',
      swingRight: d.attrs.swing_side === 'right',
      height,
      baseY: ctx.levelElevation + baseOffset,
      width: parseFloat(d.attrs.width || '0.9') || 0.9,
      thickness: d.strokeWidth || 0.04,
      material: d.attrs.material || '',
    };
  },

  draw2D(facts): ReactNode {
    const svg = getBlockSvg(facts.blockName);
    if (!svg) return null;
    const sx = facts.hingeEnd ? -1 : 1;
    const sy = facts.swingRight ? -1 : 1;
    const tx = facts.hingeEnd ? 1 : 0;
    const transform =
      `translate(${facts.start.x},${facts.start.y}) rotate(${facts.angleDeg}) ` +
      `scale(${facts.length},${facts.length}) translate(${tx},0) scale(${sx},${sy})`;
    return (
      <g data-id={facts.id} transform={transform} dangerouslySetInnerHTML={{ __html: svg }} />
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    // Box mesh sitting in the opening: center at (cx, baseY + height/2, -cy).
    // R3F coord convention here mirrors V1 doorWindowBuilder: Y=elevation, Z=-svgY.
    const cx = (facts.start.x + facts.end.x) / 2;
    const cySvg = (facts.start.y + facts.end.y) / 2;
    const cy = facts.baseY + facts.height / 2;
    const angleRad = (facts.angleDeg * Math.PI) / 180;
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'door'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        position={[cx, cy, -cySvg]}
        rotation={[0, angleRad, 0]}
        scale={[facts.length, facts.height, facts.thickness]}
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

registerElement(doorModule);
