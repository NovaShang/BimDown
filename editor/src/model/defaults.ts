export function defaultAttrs(tableName: string, levelId: string): Record<string, string> {
  const base: Record<string, string> = { base_offset: '0' };

  switch (tableName) {
    case 'wall':
    case 'structure_wall':
      return { ...base, thickness: '0.2', top_level_id: levelId, top_offset: '0', material: tableName === 'wall' ? 'Default Wall' : 'Concrete, Cast-in-Place' };
    case 'curtain_wall':
      return { ...base, top_level_id: levelId, top_offset: '0', material: 'Glass', u_grid_count: '3', v_grid_count: '3', u_spacing: '', v_spacing: '', panel_material: 'Glass' };
    case 'column':
    case 'structure_column':
      return { ...base, top_level_id: levelId, top_offset: '0', material: tableName === 'column' ? 'Concrete' : 'Steel', shape: 'rectangular', size_x: '0.3', size_y: '0.3' };
    case 'door':
      return { ...base, host_id: '', material: '', width: '0.9', height: '2.1', operation: 'single_swing', hinge_position: 'start', swing_side: 'left' };
    case 'window':
      return { ...base, host_id: '', material: '', width: '1.2', height: '1.5' };
    case 'space':
      return { ...base, name: '' };
    case 'slab':
    case 'structure_slab':
      return { ...base, material: 'Concrete', function: 'floor', thickness: '0.2' };
    case 'duct':
      return { ...base, start_z: '3', end_z: '3', shape: 'round', size_x: '0.2', size_y: '0.2', system_type: 'hvac' };
    case 'pipe':
      return { ...base, start_z: '3', end_z: '3', shape: 'round', size_x: '0.05', size_y: '0.05', system_type: 'plumbing' };
    case 'conduit':
      return { ...base, start_z: '3', end_z: '3', shape: 'round', size_x: '0.025', size_y: '0.025', system_type: 'electrical' };
    case 'cable_tray':
      return { ...base, start_z: '3', end_z: '3', size_x: '0.1', size_y: '0.1', system_type: 'electrical' };
    case 'equipment':
      return { ...base, system_type: 'hvac', equipment_type: '' };
    case 'terminal':
      return { ...base, system_type: 'hvac' };
    default:
      return base;
  }
}
