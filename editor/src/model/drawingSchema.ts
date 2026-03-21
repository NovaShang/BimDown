import { defaultAttrs } from './defaults.ts';

/**
 * Schema for the creation properties bar.
 * Defines which fields appear when drawing each element type,
 * along with display info, defaults, and constraints.
 */

export interface DrawingField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select';
  unit?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

const SHAPE_OPTIONS = [
  { value: 'rectangular', label: 'Rect' },
  { value: 'round', label: 'Round' },
];

const WALL_MATERIALS = [
  { value: 'Default Wall', label: 'Default' },
  { value: 'Concrete, Cast-in-Place', label: 'Concrete' },
  { value: 'Brick', label: 'Brick' },
  { value: 'Block', label: 'Block' },
  { value: 'Metal Stud', label: 'Metal Stud' },
];

const OPERATION_OPTIONS = [
  { value: 'single_swing', label: 'Single' },
  { value: 'double_swing', label: 'Double' },
  { value: 'sliding', label: 'Sliding' },
  { value: 'folding', label: 'Folding' },
];

const SLAB_FUNCTION_OPTIONS = [
  { value: 'floor', label: 'Floor' },
  { value: 'roof', label: 'Roof' },
  { value: 'finish', label: 'Finish' },
];

/** Fields shown in the creation properties bar for each table type */
export function getDrawingFields(tableName: string): DrawingField[] {
  switch (tableName) {
    case 'wall':
      return [
        { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
        { key: 'material', label: 'Material', type: 'select', options: WALL_MATERIALS },
      ];
    case 'structure_wall':
      return [
        { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
      ];
    case 'column':
    case 'structure_column':
      return [
        { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
      ];
    case 'door':
      return [
        { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
        { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.5, step: 0.1 },
        { key: 'operation', label: 'Type', type: 'select', options: OPERATION_OPTIONS },
      ];
    case 'window':
      return [
        { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
        { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
      ];
    case 'space':
      return [
        { key: 'name', label: 'Name', type: 'text' },
      ];
    case 'slab':
    case 'structure_slab':
      return [
        { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'function', label: 'Function', type: 'select', options: SLAB_FUNCTION_OPTIONS },
      ];
    case 'duct':
      return [
        { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
      ];
    case 'pipe':
      return [
        { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
      ];
    case 'conduit':
      return [
        { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.005, step: 0.005 },
      ];
    case 'cable_tray':
      return [
        { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
        { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      ];
    case 'equipment':
      return [
        { key: 'equipment_type', label: 'Type', type: 'text' },
      ];
    default:
      return [];
  }
}

/**
 * Build the initial drawingAttrs for a table type.
 * Seeds from defaultAttrs (the canonical defaults) filtered to drawing-relevant fields.
 */
export function getDefaultDrawingAttrs(tableName: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const fields = getDrawingFields(tableName);
  const defaults = defaultAttrs(tableName, '');
  for (const f of fields) {
    attrs[f.key] = defaults[f.key] ?? '';
  }
  return attrs;
}
