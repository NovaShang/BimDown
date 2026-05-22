/**
 * Equipment / terminal / mep_node — point archetype, MEP discipline.
 * Simple rounded-rect 2D marker + 3D box.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { EQUIPMENT_TYPE_OPTIONS, TERMINAL_TYPE_OPTIONS } from './_options.ts';

const DEFAULT_POINT_HEIGHT = 0.5;

export interface EquipmentFacts {
  id: string;
  position: Point;
  width: number;
  depth: number;
  height: number;
  rotationDeg: number;
  baseY: number;
  material: string;
  color: string;
  table: string;
}

function makeEquipmentModule(opts: {
  table: string;
  prefix: string;
  color: string;
  layerStyle: any;
  renderZIndex: number;
  defaults: Record<string, string>;
  csvHeaders: string[];
  drawingFields: any[];
}): ElementModule<EquipmentFacts> {
  return {
    table: opts.table,
    discipline: 'mep',
    archetype: 'point',
    prefix: opts.prefix,
    csvHeaders: opts.csvHeaders,
    defaults: opts.defaults,
    drawingFields: opts.drawingFields,
    propertyFields: [],
    layerStyle: opts.layerStyle,
    renderZIndex: opts.renderZIndex,

    geometry(el: CanonicalElement, ctx: GeometryContext): EquipmentFacts | null {
      if (el.geometry !== 'point') return null;
      const p = el as PointElement;
      const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
      const height = parseFloat(p.attrs.height || `${DEFAULT_POINT_HEIGHT}`) || DEFAULT_POINT_HEIGHT;
      return {
        id: p.id,
        position: p.position,
        width: p.width,
        depth: p.height,  // PointElement.height is the 2D y-extent (depth in plan)
        height,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        baseY: ctx.levelElevation + baseOffset,
        material: p.attrs.material || '',
        color: opts.color,
        table: opts.table,
      };
    },

    draw2D(facts): ReactNode {
      return (
        <g data-id={facts.id} transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`}>
          <rect
            x={-facts.width / 2} y={-facts.depth / 2}
            width={facts.width} height={facts.depth}
            fill={facts.color + '30'} stroke={facts.color}
            strokeWidth={0.02} rx={0.03} ry={0.03}
          />
        </g>
      );
    },

    draw3D(facts, drawCtx): ReactNode {
      const material = getBimMaterial(resolveBimMaterial(facts.material, facts.table));
      const isHL = drawCtx.selected || drawCtx.hovered;
      const rotY = -(facts.rotationDeg * Math.PI) / 180;
      return (
        <mesh
          position={[facts.position.x, facts.baseY + facts.height / 2, -facts.position.y]}
          rotation={[0, rotY, 0]}
          scale={[facts.width, facts.height, facts.depth]}
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

    bbox(facts) {
      return {
        x: facts.position.x - facts.width / 2,
        y: facts.position.y - facts.depth / 2,
        w: facts.width,
        h: facts.depth,
      };
    },
  };
}

export const equipmentModule = makeEquipmentModule({
  table: 'equipment', prefix: 'eq', color: '#e63946',
  csvHeaders: ['number', 'base_offset', 'system_type', 'equipment_type'],
  defaults: { base_offset: '0', system_type: '', equipment_type: 'other' },
  drawingFields: [{ key: 'equipment_type', label: 'Type', type: 'select', options: EQUIPMENT_TYPE_OPTIONS }],
  layerStyle: { displayName: 'Equipment', color: '#e63946', icon: '⚙', order: 12 },
  renderZIndex: 90,
});

export const terminalModule = makeEquipmentModule({
  table: 'terminal', prefix: 'tm', color: '#f77f00',
  csvHeaders: ['number', 'base_offset', 'system_type', 'terminal_type'],
  defaults: { base_offset: '0', system_type: '', terminal_type: 'other' },
  drawingFields: [
    { key: 'terminal_type', label: 'Type', type: 'select', options: TERMINAL_TYPE_OPTIONS },
    { key: 'system_type', label: 'System', type: 'text' },
  ],
  layerStyle: { displayName: 'Terminals', color: '#f77f00', icon: '◆', order: 13 },
  renderZIndex: 91,
});

// mep_node now lives in its own module (elements/mep_node.tsx) because it
// requires topology-driven kind derivation and per-fitting geometry. It is
// no longer co-built from this factory.

registerElement(equipmentModule);
registerElement(terminalModule);
