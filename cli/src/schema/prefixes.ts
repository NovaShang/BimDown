/** Short-id prefix per BimDown table: `{prefix}-{n}`. */
export const ID_PREFIXES: Record<string, string> = {
  level: 'lv', grid: 'gr', wall: 'w', column: 'c', slab: 'sl',
  space: 'sp', door: 'd', window: 'wn', stair: 'st',
  stair_run: 'sr', stair_landing: 'sl_land',
  ramp: 'rp', railing: 'rl', room_separator: 'rs',
  curtain_wall: 'cw', roof: 'ro', ceiling: 'cl', opening: 'op',
  structure_wall: 'sw', structure_column: 'sc', structure_slab: 'ss',
  beam: 'bm', brace: 'br', foundation: 'f',
  duct: 'du', pipe: 'pi', cable_tray: 'ct', conduit: 'co',
  equipment: 'eq', terminal: 'tm', mep_node: 'mn',
  connector: 'cn', circuit: 'ci',
  mep_system: 'sys',
  view: 'vw',
  mesh: 'ms',
  // Element types (global/ only) and the layers of layered types
  wall_type: 'wt', slab_type: 'slt', roof_type: 'rot', ceiling_type: 'clt',
  door_type: 'dt', window_type: 'wnt', curtain_wall_type: 'cwt',
  column_type: 'colt', beam_type: 'bmt', furniture_type: 'fut', railing_type: 'rlt',
  type_layer: 'tl',
  // Annotations
  dimension: 'dm', text_note: 'tx', tag: 'tg',
  // Tracing references
  underlay: 'ul',
  furniture: 'fu',
  // Drawing sheets and the views placed on them
  sheet: 'sh', sheet_viewport: 'vp',
  // Model group instances (members carry group_id)
  model_group: 'mg',
};
