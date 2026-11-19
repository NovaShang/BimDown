import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { doorPlan2D } from './_openingPlan.tsx';
import {
  MATERIAL_OPTIONS,
  OPERATION_OPTIONS,
  HINGE_OPTIONS,
  SWING_SIDE_OPTIONS,
} from './_options.ts';
import { doorMesh3D } from './_opening3D.tsx';

const BLOCK_MAP: Record<string, string> = {
  single_swing: 'door_single_swing',
  double_swing: 'door_double_swing',
  sliding: 'door_sliding',
  folding: 'door_folding',
  revolving: 'door_revolving',
};

/** Thickness of the wall hosting `el` (fallback: its own stroke). */
export function hostThicknessOf(el: LineElement, ctx: GeometryContext, fallback: number): number {
  const host = el.hostId || el.attrs.host_id ? ctx.elementById(el.hostId || el.attrs.host_id) : undefined;
  return host && (host.geometry === 'line' || host.geometry === 'spatial_line') && host.strokeWidth > 0 ? host.strokeWidth : fallback;
}

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
  /** Host wall thickness (plan drawing). */
  hostThickness: number;
  material: string;
  operation: string;
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
    { key: 'operation', label: 'Operation', type: 'select', options: OPERATION_OPTIONS },
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
      hostThickness: hostThicknessOf(d, ctx, d.strokeWidth || 0.2),
      material: d.attrs.material || '',
      operation,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    return (
      <g data-id={facts.id}>
        {doorPlan2D({ ...facts, thickness: facts.hostThickness }, drawCtx.selected)}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    return doorMesh3D(
      { ...facts, strokeWidth: facts.thickness },
      drawCtx.selected || drawCtx.hovered,
    );
  },
};

registerElement(doorModule);
