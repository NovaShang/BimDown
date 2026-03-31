import type { Level } from '../types.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type GeometryType = 'line' | 'spatial_line' | 'point' | 'polygon' | 'mixed';
export type PlacementType = 'free_line' | 'spatial_line' | 'hosted' | 'free_point' | 'free_polygon' | 'grid';

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

export interface LayerStyle {
  displayName: string;
  color: string;
  icon: string;
  order: number;
}

export interface TableDef {
  name: string;
  prefix: string;
  discipline: string;
  geometry: GeometryType;
  // Hosted element relationship
  hostType?: string;
  hostTables?: string[];
  widthAttr?: string;
  // CSV headers (non-computed, stored in CSV)
  csvHeaders: string[];
  // Default attribute values for new elements
  defaults: Record<string, string>;
  // Drawing panel fields (empty = not drawable)
  drawingFields: DrawingField[];
  // Vertical span: tables that have top_level_id constraint
  hasVerticalSpan?: boolean;
  // Render ordering and visual style
  renderZIndex: number;
  layerStyle: LayerStyle;
}

// ─── Shared option lists ─────────────────────────────────────────────────────

export const WALL_MATERIALS: DrawingField['options'] = [
  { value: 'Default Wall', label: 'Default' },
  { value: 'Concrete, Cast-in-Place', label: 'Concrete' },
  { value: 'Brick', label: 'Brick' },
  { value: 'Block', label: 'Block' },
  { value: 'Metal Stud', label: 'Metal Stud' },
];

export const OPERATION_OPTIONS: DrawingField['options'] = [
  { value: 'single_swing', label: 'Single' },
  { value: 'double_swing', label: 'Double' },
  { value: 'sliding', label: 'Sliding' },
  { value: 'folding', label: 'Folding' },
];

export const HINGE_OPTIONS: DrawingField['options'] = [
  { value: 'start', label: 'Start' },
  { value: 'end', label: 'End' },
];

export const SWING_SIDE_OPTIONS: DrawingField['options'] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

export const SHAPE_OPTIONS: DrawingField['options'] = [
  { value: 'rectangular', label: 'Rect' },
  { value: 'round', label: 'Round' },
];

export const SLAB_FUNCTION_OPTIONS: DrawingField['options'] = [
  { value: 'floor', label: 'Floor' },
  { value: 'roof', label: 'Roof' },
  { value: 'finish', label: 'Finish' },
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

export const SYSTEM_TYPE_OPTIONS: DrawingField['options'] = [
  { value: 'hvac', label: 'HVAC' },
  { value: 'plumbing', label: 'Plumbing' },
  { value: 'electrical', label: 'Electrical' },
];

// ─── Registry ────────────────────────────────────────────────────────────────

export const TABLE_REGISTRY: Record<string, TableDef> = {
  // ── Architecture ──────────────────────────────────────────────────────────
  wall: {
    name: 'wall', prefix: 'w', discipline: 'architecture', geometry: 'line',
    hasVerticalSpan: true,
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'thickness'],
    defaults: { base_offset: '0', thickness: '0.2', top_level_id: '', top_offset: '0', material: 'Default Wall' },
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
      { key: 'material', label: 'Material', type: 'select', options: WALL_MATERIALS },
    ],
    renderZIndex: 40,
    layerStyle: { displayName: 'Walls', color: '#1a1a2e', icon: '▬', order: 1 },
  },
  curtain_wall: {
    name: 'curtain_wall', prefix: 'cw', discipline: 'architecture', geometry: 'line',
    hasVerticalSpan: true,
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'u_grid_count', 'v_grid_count', 'u_spacing', 'v_spacing', 'panel_count', 'panel_material'],
    defaults: { base_offset: '0', top_level_id: '', top_offset: '0', material: 'Glass', u_grid_count: '3', v_grid_count: '3', u_spacing: '', v_spacing: '', panel_material: 'Glass' },
    drawingFields: [
      { key: 'u_grid_count', label: 'U Grids', type: 'number', min: 0, step: 1 },
      { key: 'v_grid_count', label: 'V Grids', type: 'number', min: 0, step: 1 },
      { key: 'u_spacing', label: 'U Spacing', type: 'number', unit: 'm', min: 0.1, step: 0.1 },
      { key: 'v_spacing', label: 'V Spacing', type: 'number', unit: 'm', min: 0.1, step: 0.1 },
      { key: 'panel_material', label: 'Panel Material', type: 'text' },
    ],
    renderZIndex: 40,
    layerStyle: { displayName: 'Curtain Walls', color: '#7ec8e3', icon: '⊞', order: 1.5 },
  },
  column: {
    name: 'column', prefix: 'c', discipline: 'architecture', geometry: 'point',
    hasVerticalSpan: true,
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'shape', 'size_x', 'size_y'],
    defaults: { base_offset: '0', top_level_id: '', top_offset: '0', material: 'Concrete', shape: 'rectangular', size_x: '0.3', size_y: '0.3' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
    ],
    renderZIndex: 50,
    layerStyle: { displayName: 'Columns', color: '#2d2d2d', icon: '■', order: 3 },
  },
  door: {
    name: 'door', prefix: 'd', discipline: 'architecture', geometry: 'line',
    hostType: 'wall', hostTables: ['wall', 'curtain_wall', 'structure_wall'], widthAttr: 'width',
    csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'material', 'width', 'height', 'operation', 'hinge_position', 'swing_side'],
    defaults: { base_offset: '0', host_id: '', position: '0.5', material: '', width: '0.9', height: '2.1', operation: 'single_swing', hinge_position: 'start', swing_side: 'left' },
    drawingFields: [
      { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
      { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.5, step: 0.1 },
      { key: 'operation', label: 'Type', type: 'select', options: OPERATION_OPTIONS },
      { key: 'hinge_position', label: 'Hinge', type: 'select', options: HINGE_OPTIONS },
      { key: 'swing_side', label: 'Swing', type: 'select', options: SWING_SIDE_OPTIONS },
    ],
    renderZIndex: 61,
    layerStyle: { displayName: 'Doors', color: '#0077b6', icon: '▭', order: 5 },
  },
  window: {
    name: 'window', prefix: 'wn', discipline: 'architecture', geometry: 'line',
    hostType: 'wall', hostTables: ['wall', 'curtain_wall', 'structure_wall'], widthAttr: 'width',
    csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'material', 'width', 'height'],
    defaults: { base_offset: '0', host_id: '', position: '0.5', material: '', width: '1.2', height: '1.5' },
    drawingFields: [
      { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
      { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    ],
    renderZIndex: 60,
    layerStyle: { displayName: 'Windows', color: '#48cae4', icon: '⊟', order: 5.5 },
  },
  space: {
    name: 'space', prefix: 'sp', discipline: 'architecture', geometry: 'point',
    csvHeaders: ['number', 'base_offset', 'x', 'y', 'name'],
    defaults: { base_offset: '0', x: '0', y: '0', name: '' },
    drawingFields: [
      { key: 'name', label: 'Name', type: 'text' },
    ],
    renderZIndex: 10,
    layerStyle: { displayName: 'Spaces', color: '#3a86ff', icon: '⬡', order: 6 },
  },
  room_separator: {
    name: 'room_separator', prefix: 'rs', discipline: 'architecture', geometry: 'line',
    csvHeaders: ['number', 'base_offset'],
    defaults: { base_offset: '0' },
    drawingFields: [],
    renderZIndex: 15,
    layerStyle: { displayName: 'Room Separators', color: '#adb5bd', icon: '╌', order: 6.5 },
  },
  slab: {
    name: 'slab', prefix: 'sl', discipline: 'architecture', geometry: 'polygon',
    csvHeaders: ['number', 'base_offset', 'material', 'function', 'thickness'],
    defaults: { base_offset: '0', material: 'Concrete', function: 'floor', thickness: '0.2' },
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'function', label: 'Function', type: 'select', options: SLAB_FUNCTION_OPTIONS },
    ],
    renderZIndex: 20,
    layerStyle: { displayName: 'Slabs', color: '#adb5bd', icon: '▨', order: 7 },
  },
  roof: {
    name: 'roof', prefix: 'ro', discipline: 'architecture', geometry: 'polygon',
    csvHeaders: ['number', 'base_offset', 'material', 'roof_type', 'slope', 'thickness'],
    defaults: { base_offset: '0', material: 'Concrete', roof_type: 'flat', slope: '0', thickness: '0.2' },
    drawingFields: [
      { key: 'roof_type', label: 'Type', type: 'select', options: ROOF_TYPE_OPTIONS },
      { key: 'slope', label: 'Slope', type: 'number', unit: '°', min: 0, max: 60, step: 5 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    ],
    renderZIndex: 19,
    layerStyle: { displayName: 'Roofs', color: '#8d6e63', icon: '△', order: 7.5 },
  },
  ceiling: {
    name: 'ceiling', prefix: 'cl', discipline: 'architecture', geometry: 'polygon',
    csvHeaders: ['number', 'base_offset', 'material', 'height_offset'],
    defaults: { base_offset: '0', material: 'Gypsum', height_offset: '-0.3' },
    drawingFields: [
      { key: 'height_offset', label: 'Drop', type: 'number', unit: 'm', step: 0.05 },
    ],
    renderZIndex: 18,
    layerStyle: { displayName: 'Ceilings', color: '#b0bec5', icon: '▤', order: 7.8 },
  },
  opening: {
    name: 'opening', prefix: 'op', discipline: 'architecture', geometry: 'mixed',
    hostType: 'wall', hostTables: ['wall', 'curtain_wall', 'structure_wall', 'slab', 'structure_slab'], widthAttr: 'width',
    csvHeaders: ['number', 'base_offset', 'host_id', 'position', 'width', 'height', 'shape'],
    defaults: { base_offset: '0', host_id: '', position: '0.5', width: '1.0', height: '2.4', shape: 'rect' },
    drawingFields: [
      { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
      { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
      { key: 'shape', label: 'Shape', type: 'select', options: OPENING_SHAPE_OPTIONS },
    ],
    renderZIndex: 62,
    layerStyle: { displayName: 'Openings', color: '#ff8a65', icon: '▢', order: 5.8 },
  },
  stair: {
    name: 'stair', prefix: 'st', discipline: 'architecture', geometry: 'polygon',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'width', 'rise', 'run'],
    defaults: { base_offset: '0' },
    drawingFields: [],
    renderZIndex: 30,
    layerStyle: { displayName: 'Stairs', color: '#7b68ee', icon: '⊞', order: 9 },
  },

  ramp: {
    name: 'ramp', prefix: 'rp', discipline: 'architecture', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'start_z', 'end_z', 'width', 'material'],
    defaults: { base_offset: '0', top_level_id: '', start_z: '0', end_z: '3', width: '1.2', material: 'Concrete' },
    drawingFields: [
      { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    ],
    renderZIndex: 31,
    layerStyle: { displayName: 'Ramps', color: '#7b68ee', icon: '⟋', order: 9.1 },
  },
  railing: {
    name: 'railing', prefix: 'rl', discipline: 'architecture', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'start_z', 'end_z', 'height', 'material'],
    defaults: { base_offset: '0', top_level_id: '', start_z: '0', end_z: '0', height: '1.0', material: 'Metal' },
    drawingFields: [
      { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    ],
    renderZIndex: 32,
    layerStyle: { displayName: 'Railings', color: '#546e7a', icon: '┃', order: 9.2 },
  },

  // ── Structure ─────────────────────────────────────────────────────────────
  structure_wall: {
    name: 'structure_wall', prefix: 'sw', discipline: 'structure', geometry: 'line',
    hasVerticalSpan: true,
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material'],
    defaults: { base_offset: '0', thickness: '0.2', top_level_id: '', top_offset: '0', material: 'Concrete, Cast-in-Place' },
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    ],
    renderZIndex: 41,
    layerStyle: { displayName: 'Str. Walls', color: '#4a3728', icon: '▬', order: 2 },
  },
  structure_column: {
    name: 'structure_column', prefix: 'sc', discipline: 'structure', geometry: 'point',
    hasVerticalSpan: true,
    csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'shape', 'size_x', 'size_y'],
    defaults: { base_offset: '0', top_level_id: '', top_offset: '0', material: 'Steel', shape: 'rectangular', size_x: '0.3', size_y: '0.3' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
    ],
    renderZIndex: 51,
    layerStyle: { displayName: 'Str. Columns', color: '#5c3d2e', icon: '■', order: 4 },
  },
  structure_slab: {
    name: 'structure_slab', prefix: 'ss', discipline: 'structure', geometry: 'polygon',
    csvHeaders: ['number', 'base_offset', 'material', 'function', 'thickness'],
    defaults: { base_offset: '0', material: 'Concrete', function: 'floor', thickness: '0.2' },
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'function', label: 'Function', type: 'select', options: SLAB_FUNCTION_OPTIONS },
    ],
    renderZIndex: 21,
    layerStyle: { displayName: 'Str. Slabs', color: '#8d6e63', icon: '▨', order: 8 },
  },
  beam: {
    name: 'beam', prefix: 'bm', discipline: 'structure', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'material'],
    defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'rectangular', size_x: '0.3', size_y: '0.5', material: 'Steel' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
      { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
    ],
    renderZIndex: 70,
    layerStyle: { displayName: 'Beams', color: '#8d6e63', icon: '━', order: 16 },
  },
  brace: {
    name: 'brace', prefix: 'br', discipline: 'structure', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'material'],
    defaults: { base_offset: '0', start_z: '0', end_z: '3', shape: 'rectangular', size_x: '0.2', size_y: '0.2', material: 'Steel' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
    ],
    renderZIndex: 71,
    layerStyle: { displayName: 'Braces', color: '#8d6e63', icon: '╲', order: 17 },
  },
  foundation: {
    name: 'foundation', prefix: 'f', discipline: 'structure', geometry: 'mixed',
    csvHeaders: ['number', 'base_offset', 'thickness', 'width', 'length', 'material'],
    defaults: { base_offset: '0', material: 'Concrete', thickness: '0.4' },
    drawingFields: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
    ],
    renderZIndex: 22,
    layerStyle: { displayName: 'Foundations', color: '#8d6e63', icon: '▨', order: 8.1 },
  },

  // ── MEP ───────────────────────────────────────────────────────────────────
  duct: {
    name: 'duct', prefix: 'du', discipline: 'mep', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'system_type', 'start_node_id', 'end_node_id'],
    defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.2', size_y: '0.2', system_type: 'hvac' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_OPTIONS },
    ],
    renderZIndex: 80,
    layerStyle: { displayName: 'Ducts', color: '#00b4d8', icon: '═', order: 10 },
  },
  pipe: {
    name: 'pipe', prefix: 'pi', discipline: 'mep', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'system_type', 'start_node_id', 'end_node_id'],
    defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.05', size_y: '0.05', system_type: 'plumbing' },
    drawingFields: [
      { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    ],
    renderZIndex: 81,
    layerStyle: { displayName: 'Pipes', color: '#06d6a0', icon: '║', order: 11 },
  },
  conduit: {
    name: 'conduit', prefix: 'co', discipline: 'mep', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'system_type', 'start_node_id', 'end_node_id'],
    defaults: { base_offset: '0', start_z: '3', end_z: '3', shape: 'round', size_x: '0.025', size_y: '0.025', system_type: 'electrical' },
    drawingFields: [
      { key: 'size_x', label: 'Diameter', type: 'number', unit: 'm', min: 0.005, step: 0.005 },
    ],
    renderZIndex: 83,
    layerStyle: { displayName: 'Conduits', color: '#ffd166', icon: '│', order: 14 },
  },
  cable_tray: {
    name: 'cable_tray', prefix: 'ct', discipline: 'mep', geometry: 'spatial_line',
    csvHeaders: ['number', 'base_offset', 'start_z', 'end_z', 'shape', 'size_x', 'size_y', 'system_type', 'start_node_id', 'end_node_id'],
    defaults: { base_offset: '0', start_z: '3', end_z: '3', size_x: '0.1', size_y: '0.1', system_type: 'electrical' },
    drawingFields: [
      { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
      { key: 'size_y', label: 'Height', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    ],
    renderZIndex: 82,
    layerStyle: { displayName: 'Cable Trays', color: '#ffd166', icon: '╤', order: 15 },
  },
  equipment: {
    name: 'equipment', prefix: 'eq', discipline: 'mep', geometry: 'point',
    csvHeaders: ['number', 'base_offset', 'system_type', 'equipment_type'],
    defaults: { base_offset: '0', system_type: 'hvac', equipment_type: '' },
    drawingFields: [
      { key: 'equipment_type', label: 'Type', type: 'text' },
    ],
    renderZIndex: 90,
    layerStyle: { displayName: 'Equipment', color: '#e63946', icon: '⚙', order: 12 },
  },
  terminal: {
    name: 'terminal', prefix: 'tm', discipline: 'mep', geometry: 'point',
    csvHeaders: ['number', 'base_offset', 'system_type'],
    defaults: { base_offset: '0', system_type: 'hvac' },
    drawingFields: [
      { key: 'system_type', label: 'System', type: 'text' },
    ],
    renderZIndex: 91,
    layerStyle: { displayName: 'Terminals', color: '#f77f00', icon: '◆', order: 13 },
  },

  mep_node: {
    name: 'mep_node', prefix: 'mn', discipline: 'mep', geometry: 'point',
    csvHeaders: ['number', 'base_offset', 'system_type'],
    defaults: { base_offset: '0', system_type: 'hvac' },
    drawingFields: [],
    renderZIndex: 92,
    layerStyle: { displayName: 'MEP Nodes', color: '#ff6b6b', icon: '●', order: 13.5 },
  },

  // ── Mesh (non-parametric elements) ────────────────────────────────────────
  mesh: {
    name: 'mesh', prefix: 'ms', discipline: 'reference', geometry: 'point',
    csvHeaders: ['category', 'name', 'level_id', 'mesh_file', 'x', 'y', 'z', 'rotation'],
    defaults: { category: '', name: '', level_id: '', mesh_file: '', x: '0', y: '0', z: '0', rotation: '0' },
    drawingFields: [
      { key: 'category', label: 'Category', type: 'text' },
    ],
    renderZIndex: 5,
    layerStyle: { displayName: 'Mesh Objects', color: '#9e9e9e', icon: '◇', order: 20 },
  },

  // ── Reference ─────────────────────────────────────────────────────────────
  grid: {
    name: 'grid', prefix: 'gr', discipline: 'reference', geometry: 'line',
    csvHeaders: ['number'],
    defaults: {},
    drawingFields: [],
    renderZIndex: 1,
    layerStyle: { displayName: 'Grids', color: '#ef476f', icon: '┼', order: 0 },
  },
};

// ─── Derived lookup maps ─────────────────────────────────────────────────────

const _byPrefix = new Map<string, string>();
const _byDiscipline = new Map<string, string[]>();

for (const [name, def] of Object.entries(TABLE_REGISTRY)) {
  _byPrefix.set(def.prefix, name);
  const list = _byDiscipline.get(def.discipline) ?? [];
  list.push(name);
  _byDiscipline.set(def.discipline, list);
}

// ─── Query functions ─────────────────────────────────────────────────────────

export function geometryTypeForTable(name: string): GeometryType | null {
  return TABLE_REGISTRY[name]?.geometry ?? null;
}

export function placementTypeForTable(name: string): PlacementType {
  const def = TABLE_REGISTRY[name];
  if (!def) return 'free_line';
  if (name === 'grid') return 'grid';
  if (def.hostType) return 'hosted';
  switch (def.geometry) {
    case 'point': return 'free_point';
    case 'polygon': return 'free_polygon';
    case 'spatial_line': return 'spatial_line';
    default: return 'free_line';
  }
}

export function prefixForTable(name: string): string {
  return TABLE_REGISTRY[name]?.prefix ?? 'x';
}

export function tableByPrefix(prefix: string): string | null {
  return _byPrefix.get(prefix) ?? null;
}

export function csvHeadersForTable(name: string): string[] {
  return TABLE_REGISTRY[name]?.csvHeaders ?? ['number', 'base_offset'];
}

export function defaultAttrsForTable(name: string, levelId: string): Record<string, string> {
  const def = TABLE_REGISTRY[name];
  if (!def) return { base_offset: '0' };
  const attrs = { ...def.defaults };
  if (def.hasVerticalSpan && attrs.top_level_id === '') {
    attrs.top_level_id = levelId;
  }
  return attrs;
}

/** Tables that have a top_level_id constraint */
const VERTICAL_SPAN_TABLES = new Set(
  Object.entries(TABLE_REGISTRY).filter(([, d]) => d.hasVerticalSpan).map(([n]) => n)
);

export function drawingFieldsForTable(name: string, levels?: Level[]): DrawingField[] {
  const def = TABLE_REGISTRY[name];
  if (!def) return [];

  const topFields: DrawingField[] = VERTICAL_SPAN_TABLES.has(name) && levels
    ? [
        { key: 'top_level_id', label: 'Top', type: 'select', options: levels.map(l => ({ value: l.id, label: l.name || l.id })) },
        { key: 'top_offset', label: 'Top Offset', type: 'number', unit: 'm', step: 0.1 },
      ]
    : [];

  return [...def.drawingFields, ...topFields];
}

export function isHostedTable(name: string): boolean {
  return !!TABLE_REGISTRY[name]?.hostType;
}

export function hostTablesFor(name: string): Set<string> {
  return new Set(TABLE_REGISTRY[name]?.hostTables ?? []);
}

export function widthAttrFor(name: string): string {
  return TABLE_REGISTRY[name]?.widthAttr ?? 'width';
}

export function renderZIndexForTable(name: string): number {
  return TABLE_REGISTRY[name]?.renderZIndex ?? 100;
}

export function layerStyleForTable(name: string): LayerStyle {
  return TABLE_REGISTRY[name]?.layerStyle ?? { displayName: name, color: '#888', icon: '?', order: 99 };
}

export function disciplineForTable(name: string): string {
  return TABLE_REGISTRY[name]?.discipline ?? '';
}

export function tablesForDiscipline(discipline: string): string[] {
  return _byDiscipline.get(discipline) ?? [];
}

export function allTableNames(): string[] {
  return Object.keys(TABLE_REGISTRY);
}

// ─── Discipline metadata ─────────────────────────────────────────────────────

export const DISCIPLINE_COLORS: Record<string, string> = {
  architecture: '#3a86ff',
  structure:     '#e07a2f',
  mep:           '#00b4d8',
  reference:     '#ef476f',
};

export const DISCIPLINES = Object.keys(DISCIPLINE_COLORS);
