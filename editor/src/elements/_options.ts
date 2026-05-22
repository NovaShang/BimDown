/**
 * Shared option lists for ElementModule.drawingFields.
 *
 * These live independently of tableRegistry so element modules can import
 * them without circular dependency on the (transitional) tableRegistry shim.
 */
import type { DrawingField } from '../model/tableRegistry.ts';

/** Spec v3 materialized.material enum */
export const MATERIAL_OPTIONS: DrawingField['options'] = [
  { value: 'concrete', label: 'Concrete' },
  { value: 'steel', label: 'Steel' },
  { value: 'wood', label: 'Wood' },
  { value: 'clt', label: 'CLT' },
  { value: 'glass', label: 'Glass' },
  { value: 'aluminum', label: 'Aluminum' },
  { value: 'brick', label: 'Brick' },
  { value: 'stone', label: 'Stone' },
  { value: 'gypsum', label: 'Gypsum' },
  { value: 'insulation', label: 'Insulation' },
  { value: 'copper', label: 'Copper' },
  { value: 'pvc', label: 'PVC' },
  { value: 'ceramic', label: 'Ceramic' },
  { value: 'fiber_cement', label: 'Fiber Cement' },
  { value: 'composite', label: 'Composite' },
];

export const OPERATION_OPTIONS: DrawingField['options'] = [
  { value: 'single_swing', label: 'Single' },
  { value: 'double_swing', label: 'Double' },
  { value: 'sliding', label: 'Sliding' },
  { value: 'folding', label: 'Folding' },
  { value: 'revolving', label: 'Revolving' },
];

export const HINGE_OPTIONS: DrawingField['options'] = [
  { value: 'start', label: 'Start' },
  { value: 'end', label: 'End' },
];

export const SWING_SIDE_OPTIONS: DrawingField['options'] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

/** Spec v3 section_profile.shape enum */
export const SHAPE_OPTIONS: DrawingField['options'] = [
  { value: 'rect', label: 'Rect' },
  { value: 'round', label: 'Round' },
];

/** Spec v3 structural_section_profile.shape enum */
export const STRUCTURAL_SHAPE_OPTIONS: DrawingField['options'] = [
  { value: 'rect', label: 'Rect' },
  { value: 'round', label: 'Round' },
  { value: 'i_shape', label: 'I-Shape' },
  { value: 't_shape', label: 'T-Shape' },
  { value: 'l_shape', label: 'L-Shape' },
  { value: 'c_shape', label: 'C-Shape' },
  { value: 'cross', label: 'Cross' },
];

export const SLAB_FUNCTION_OPTIONS: DrawingField['options'] = [
  { value: 'floor', label: 'Floor' },
  { value: 'roof', label: 'Roof' },
  { value: 'finish', label: 'Finish' },
];

export const STRUCTURE_SLAB_FUNCTION_OPTIONS: DrawingField['options'] = [
  { value: 'floor', label: 'Floor' },
  { value: 'roof', label: 'Roof' },
];

export const ROOF_TYPE_OPTIONS: DrawingField['options'] = [
  { value: 'flat', label: 'Flat' },
  { value: 'gable', label: 'Gable' },
  { value: 'hip', label: 'Hip' },
  { value: 'shed', label: 'Shed' },
  { value: 'mansard', label: 'Mansard' },
];

export const OPENING_SHAPE_OPTIONS: DrawingField['options'] = [
  { value: 'rect', label: 'Rect' },
  { value: 'round', label: 'Round' },
  { value: 'arch', label: 'Arch' },
];

export const EQUIPMENT_TYPE_OPTIONS: DrawingField['options'] = [
  { value: 'ahu', label: 'AHU' },
  { value: 'fcu', label: 'FCU' },
  { value: 'chiller', label: 'Chiller' },
  { value: 'boiler', label: 'Boiler' },
  { value: 'cooling_tower', label: 'Cooling Tower' },
  { value: 'fan', label: 'Fan' },
  { value: 'pump', label: 'Pump' },
  { value: 'transformer', label: 'Transformer' },
  { value: 'panelboard', label: 'Panelboard' },
  { value: 'generator', label: 'Generator' },
  { value: 'water_heater', label: 'Water Heater' },
  { value: 'tank', label: 'Tank' },
  { value: 'other', label: 'Other' },
];

export const TERMINAL_TYPE_OPTIONS: DrawingField['options'] = [
  { value: 'supply_air_diffuser', label: 'Supply Air Diffuser' },
  { value: 'return_air_grille', label: 'Return Air Grille' },
  { value: 'exhaust_air_grille', label: 'Exhaust Air Grille' },
  { value: 'sprinkler_head', label: 'Sprinkler Head' },
  { value: 'fire_alarm_device', label: 'Fire Alarm Device' },
  { value: 'light_fixture', label: 'Light Fixture' },
  { value: 'power_outlet', label: 'Power Outlet' },
  { value: 'data_outlet', label: 'Data Outlet' },
  { value: 'plumbing_fixture', label: 'Plumbing Fixture' },
  { value: 'other', label: 'Other' },
];
