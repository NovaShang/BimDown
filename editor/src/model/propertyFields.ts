import type { Level } from '../types.ts';
import {
  TABLE_REGISTRY,
  MATERIAL_OPTIONS,
  SHAPE_OPTIONS,
  SLAB_FUNCTION_OPTIONS,
  OPERATION_OPTIONS,
  HINGE_OPTIONS,
  SWING_SIDE_OPTIONS,
  ROOF_TYPE_OPTIONS,
  EQUIPMENT_TYPE_OPTIONS,
  TERMINAL_TYPE_OPTIONS,
} from './tableRegistry.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyGroup = 'identity' | 'geometry' | 'material' | 'relationships' | 'system' | 'curtain_wall' | 'roof' | 'mesh';

export interface PropertyField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select' | 'readonly';
  unit?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  group: PropertyGroup;
}

// ─── Global property field definitions ───────────────────────────────────────

const PROPERTY_FIELD_DEFS: Record<string, PropertyField> = {
  // Identity
  id:              { key: 'id',              label: 'ID',              type: 'readonly', group: 'identity' },
  number:          { key: 'number',          label: 'Number',          type: 'text',     group: 'identity' },
  name:            { key: 'name',            label: 'Name',            type: 'text',     group: 'identity' },

  // Geometry — editable dimensions
  base_offset:     { key: 'base_offset',     label: 'Base Offset',     type: 'number', unit: 'm', step: 0.1, group: 'geometry' },
  top_offset:      { key: 'top_offset',      label: 'Top Offset',      type: 'number', unit: 'm', step: 0.1, group: 'geometry' },
  thickness:       { key: 'thickness',       label: 'Thickness',       type: 'number', unit: 'm', min: 0.01, step: 0.01, group: 'geometry' },
  width:           { key: 'width',           label: 'Width',           type: 'number', unit: 'm', min: 0.1, step: 0.1, group: 'geometry' },
  height:          { key: 'height',          label: 'Height',          type: 'number', unit: 'm', min: 0.1, step: 0.1, group: 'geometry' },
  size_x:          { key: 'size_x',          label: 'Size X',          type: 'number', unit: 'm', min: 0.01, step: 0.05, group: 'geometry' },
  size_y:          { key: 'size_y',          label: 'Size Y',          type: 'number', unit: 'm', min: 0.01, step: 0.05, group: 'geometry' },
  start_z:         { key: 'start_z',         label: 'Start Z',         type: 'number', unit: 'm', step: 0.1, group: 'geometry' },
  end_z:           { key: 'end_z',           label: 'End Z',           type: 'number', unit: 'm', step: 0.1, group: 'geometry' },
  position:        { key: 'position',        label: 'Position',        type: 'number', unit: 'm', min: 0, step: 0.05, group: 'geometry' },
  shape:           { key: 'shape',           label: 'Shape',           type: 'select', options: SHAPE_OPTIONS, group: 'geometry' },
  height_offset:   { key: 'height_offset',   label: 'Drop',            type: 'number', unit: 'm', step: 0.05, group: 'geometry' },

  // Geometry — readonly computed
  length:          { key: 'length',          label: 'Length',           type: 'readonly', group: 'geometry' },
  area:            { key: 'area',            label: 'Area',            type: 'readonly', group: 'geometry' },
  x:               { key: 'x',              label: 'X',               type: 'readonly', group: 'geometry' },
  y:               { key: 'y',              label: 'Y',               type: 'readonly', group: 'geometry' },

  // Material
  material:        { key: 'material',        label: 'Material',        type: 'select', options: MATERIAL_OPTIONS, group: 'material' },
  function:        { key: 'function',        label: 'Function',        type: 'select', options: SLAB_FUNCTION_OPTIONS, group: 'material' },

  // Relationships
  top_level_id:    { key: 'top_level_id',    label: 'Top Level',       type: 'select', group: 'relationships' },
  host_id:         { key: 'host_id',         label: 'Host',            type: 'readonly', group: 'relationships' },
  start_node_id:   { key: 'start_node_id',   label: 'Start Node',      type: 'readonly', group: 'relationships' },
  end_node_id:     { key: 'end_node_id',     label: 'End Node',        type: 'readonly', group: 'relationships' },

  // System
  operation:       { key: 'operation',       label: 'Operation',       type: 'select', options: OPERATION_OPTIONS, group: 'system' },
  hinge_position:  { key: 'hinge_position',  label: 'Hinge',           type: 'select', options: HINGE_OPTIONS, group: 'system' },
  swing_side:      { key: 'swing_side',      label: 'Swing',           type: 'select', options: SWING_SIDE_OPTIONS, group: 'system' },
  system_type:     { key: 'system_type',     label: 'System Type',     type: 'text',   group: 'system' },
  equipment_type:  { key: 'equipment_type',  label: 'Equipment Type',  type: 'select', options: EQUIPMENT_TYPE_OPTIONS, group: 'system' },
  terminal_type:   { key: 'terminal_type',   label: 'Terminal Type',   type: 'select', options: TERMINAL_TYPE_OPTIONS, group: 'system' },

  // Curtain wall
  u_grid_count:    { key: 'u_grid_count',    label: 'U Grids',         type: 'number', min: 0, step: 1, group: 'curtain_wall' },
  v_grid_count:    { key: 'v_grid_count',    label: 'V Grids',         type: 'number', min: 0, step: 1, group: 'curtain_wall' },
  u_spacing:       { key: 'u_spacing',       label: 'U Spacing',       type: 'number', unit: 'm', min: 0.1, step: 0.1, group: 'curtain_wall' },
  v_spacing:       { key: 'v_spacing',       label: 'V Spacing',       type: 'number', unit: 'm', min: 0.1, step: 0.1, group: 'curtain_wall' },
  panel_count:     { key: 'panel_count',     label: 'Panel Count',     type: 'readonly', group: 'curtain_wall' },
  panel_material:  { key: 'panel_material',  label: 'Panel Material',  type: 'text',   group: 'curtain_wall' },

  // Roof
  roof_type:       { key: 'roof_type',       label: 'Roof Type',       type: 'select', options: ROOF_TYPE_OPTIONS, group: 'roof' },
  slope:           { key: 'slope',           label: 'Slope',           type: 'number', unit: '°', min: 0, max: 60, step: 5, group: 'roof' },

  // Stair
  step_count:      { key: 'step_count',      label: 'Steps',           type: 'number', min: 1, step: 1, group: 'geometry' },

  // Opening
  // shape is handled by the global def, but opening uses OPENING_SHAPE_OPTIONS — handled via drawingFields override

  // Mesh
  category:        { key: 'category',        label: 'Category',        type: 'text',   group: 'mesh' },
  level_id:        { key: 'level_id',        label: 'Level',           type: 'readonly', group: 'mesh' },
  mesh_file:       { key: 'mesh_file',       label: 'Mesh File',       type: 'readonly', group: 'mesh' },
  z:               { key: 'z',              label: 'Z',               type: 'readonly', group: 'mesh' },
  rotation:        { key: 'rotation',        label: 'Rotation',        type: 'number', unit: '°', step: 15, group: 'mesh' },
};

// ─── Ordered property groups ─────────────────────────────────────────────────

export const PROPERTY_GROUPS: { key: PropertyGroup; labelKey: string }[] = [
  { key: 'identity',      labelKey: 'prop.Identity' },
  { key: 'geometry',      labelKey: 'prop.Geometry' },
  { key: 'material',      labelKey: 'prop.Material' },
  { key: 'relationships', labelKey: 'prop.Relationships' },
  { key: 'system',        labelKey: 'prop.System' },
  { key: 'curtain_wall',  labelKey: 'prop.CurtainWall' },
  { key: 'roof',          labelKey: 'prop.Roof' },
  { key: 'mesh',          labelKey: 'prop.Mesh' },
];

// ─── Resolver ────────────────────────────────────────────────────────────────

export function getPropertyFields(tableName: string, levels?: Level[]): PropertyField[] {
  const def = TABLE_REGISTRY[tableName];
  if (!def) return [];

  const drawingByKey = new Map(def.drawingFields.map(f => [f.key, f]));
  const allKeys = def.csvHeaders;
  const fields: PropertyField[] = [];

  for (const key of allKeys) {
    const drawing = drawingByKey.get(key);
    const global = PROPERTY_FIELD_DEFS[key];

    if (global) {
      const resolved: PropertyField = { ...global };

      // drawingFields override label and options (table-specific names like "Diameter" for size_x on pipes)
      if (drawing) {
        resolved.label = drawing.label;
        if (drawing.options) resolved.options = drawing.options;
        if (drawing.min !== undefined) resolved.min = drawing.min;
        if (drawing.max !== undefined) resolved.max = drawing.max;
        if (drawing.step !== undefined) resolved.step = drawing.step;
        if (drawing.unit) resolved.unit = drawing.unit;
      }

      // Inject level options dynamically for top_level_id
      if (key === 'top_level_id' && levels) {
        resolved.options = levels.map(l => ({ value: l.id, label: l.name || l.id }));
      }

      fields.push(resolved);
    } else if (drawing) {
      // Known in drawingFields but not in global defs
      fields.push({
        key,
        label: drawing.label,
        type: drawing.type === 'select' ? 'select' : drawing.type === 'number' ? 'number' : 'text',
        unit: drawing.unit,
        options: drawing.options,
        min: drawing.min,
        max: drawing.max,
        step: drawing.step,
        group: 'geometry',
      });
    } else {
      // Unknown field — generic text fallback
      fields.push({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        type: 'text',
        group: 'identity',
      });
    }
  }

  return fields;
}
