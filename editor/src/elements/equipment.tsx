/**
 * Equipment / terminal — point archetype, MEP discipline.
 * Plan symbol by type with a tag; simple 3D body by type (mep/DeviceView).
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { Device2D, Device3D, type DeviceFacts } from '../mep/DeviceView.tsx';
import { resolveMepSystemColor } from './_mepLineShared.tsx';
import { BASE_OFFSET_FIELD, EQUIPMENT_TYPE_OPTIONS, TERMINAL_TYPE_OPTIONS } from './_options.ts';
import { equipmentStarters } from './equipment_starters.ts';

/** Reserved drawingAttrs key (double underscore = UI-only flag, stripped at
 *  commit time). When set, the placement tool materializes a starter
 *  template — host row + default connector rows — instead of a bare row. */
export const STARTER_KEY_ATTR = '__starter_key';

const STARTER_OPTIONS_EQUIPMENT = [
  { value: '', label: 'None' },
  ...equipmentStarters
    .filter((s) => s.table === 'equipment')
    .map((s) => ({ value: s.key, label: s.label_en })), // translated via option.*
];

const STARTER_OPTIONS_TERMINAL = [
  { value: '', label: 'None' },
  ...equipmentStarters
    .filter((s) => s.table === 'terminal')
    .map((s) => ({ value: s.key, label: s.label_en })), // translated via option.*
];

const DEFAULT_POINT_HEIGHT = 0.5;

export type EquipmentFacts = DeviceFacts;

function makeEquipmentModule(opts: {
  table: string;
  prefix: string;
  color: string;
  layerStyle: any;
  renderZIndex: number;
  defaults: Record<string, string>;
  csvHeaders: string[];
  drawingFields: any[];
  toolbarVariants?: ElementModule['toolbarVariants'];
}): ElementModule<EquipmentFacts> {
  const typeKey = opts.table === 'equipment' ? 'equipment_type' : 'terminal_type';
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
    toolbarVariants: opts.toolbarVariants,

    geometry(el: CanonicalElement, ctx: GeometryContext): EquipmentFacts | null {
      if (el.geometry !== 'point') return null;
      const p = el as PointElement;
      const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
      const height = parseFloat(p.attrs.height || `${DEFAULT_POINT_HEIGHT}`) || DEFAULT_POINT_HEIGHT;
      const systemType = p.attrs.system_type || '';
      const first = systemType.split(',')[0].trim();
      const override = first ? ctx.projectSystems().find(s => s.system_type.trim() === first)?.color : undefined;
      return {
        id: p.id,
        table: opts.table,
        position: p.position,
        width: p.width,
        depth: p.height,  // PointElement.height is the 2D y-extent (depth in plan)
        height,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        baseY: ctx.levelElevation + baseOffset,
        material: p.attrs.material || '',
        color: opts.color,
        type: p.attrs[typeKey] || 'other',
        number: p.attrs.number || '',
        systemType,
        systemColor: first ? resolveMepSystemColor(first, override) : '',
        flow: parseFloat(p.attrs.flow || '0') || 0,
        load: parseFloat(p.attrs.load || '0') || 0,
        circuit: p.attrs.circuit_id || '',
      };
    },

    draw2D(facts, drawCtx): ReactNode {
      return <Device2D facts={facts} selected={drawCtx.selected} />;
    },

    draw3D(facts, drawCtx): ReactNode {
      return <Device3D facts={facts} isHL={drawCtx.selected || drawCtx.hovered} />;
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
  csvHeaders: ['number', 'base_offset', 'height', 'system_type', 'equipment_type', 'family', 'type', 'rotation', 'flow', 'load', 'circuit_id'],
  defaults: { base_offset: '0', system_type: '', equipment_type: 'other', family: '', type: '', rotation: '0' },
  drawingFields: [
    { key: STARTER_KEY_ATTR, label: 'Template', type: 'select', options: STARTER_OPTIONS_EQUIPMENT },
    { key: 'equipment_type', label: 'Type', type: 'select', options: EQUIPMENT_TYPE_OPTIONS },
    { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', step: 15 },
    BASE_OFFSET_FIELD,
  ],
  layerStyle: { displayName: 'Equipment', color: '#e63946', icon: '⚙', order: 12 },
  renderZIndex: 90,
});

export const terminalModule = makeEquipmentModule({
  table: 'terminal', prefix: 'tm', color: '#f77f00',
  csvHeaders: ['number', 'base_offset', 'height', 'system_type', 'terminal_type', 'family', 'type', 'rotation', 'flow', 'load', 'circuit_id'],
  defaults: { base_offset: '0', system_type: '', terminal_type: 'other', family: '', type: '', rotation: '0' },
  drawingFields: [
    { key: STARTER_KEY_ATTR, label: 'Template', type: 'select', options: STARTER_OPTIONS_TERMINAL },
    { key: 'terminal_type', label: 'Type', type: 'select', options: TERMINAL_TYPE_OPTIONS },
    { key: 'system_type', label: 'System', type: 'text' },
    { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', step: 15 },
    BASE_OFFSET_FIELD,
  ],
  layerStyle: { displayName: 'Terminals', color: '#f77f00', icon: '◆', order: 13 },
  renderZIndex: 91,
  // Single placement, or an array over a rectangle (sprinkler grid with its
  // branch piping, light grid) — mep/arrayTool.ts.
  toolbarVariants: [
    { id: 'single', label: 'layer.terminal', icon: '◆', iconName: 'terminal', placementType: 'free_point' },
    { id: 'array', label: 'mep.tool.array', icon: '⁙', placementType: 'free_point' },
  ],
});

// mep_node now lives in its own module (elements/mep_node.tsx) because it
// requires topology-driven kind derivation and per-fitting geometry. It is
// no longer co-built from this factory.

registerElement(equipmentModule);
registerElement(terminalModule);
