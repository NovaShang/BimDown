/**
 * Text for `bimdown schema` (and the agent's model_schema tool).
 * No table: a compact index (one line per table, a few key fields) — the full
 * dump of every table is ~40k characters. With a table: its full columns.
 */
import type { ResolvedTable } from './types.js';
import { typeParamFields } from '../catalog/index.js';
import { furnitureCatalogLines } from '../furniture/catalog-text.js';

/** Table → one-line purpose with its key fields, grouped as printed. */
const INDEX: [group: string, tables: [string, string][]][] = [
  ['Project (global/)', [
    ['level', 'storey: number, elevation (absolute)'],
    ['grid', 'axis line: number, start/end x y'],
    ['view', 'section / elevation / 3D view: view_type, cut line'],
    ['underlay', 'tracing image / PDF under a level: level_id, file'],
    ['mesh', 'imported GLB: category, mesh_file'],
    ['sheet', 'drawing sheet: number, paper'],
    ['sheet_viewport', 'view placed on a sheet: sheet_id, view_type, x y'],
  ]],
  ['Architecture', [
    ['wall', 'line: thickness, type_id, base_offset/top_level_id/top_offset'],
    ['curtain_wall', 'line: u/v grids, panels, mullions'],
    ['column', 'point: shape, size_x/size_y'],
    ['slab', 'polygon floor, top = level + base_offset: thickness'],
    ['roof', 'polygon: roof_type (flat/gable/hip...), slope'],
    ['ceiling', 'polygon: height_offset'],
    ['space', 'room seed point: x y, name; boundary computed'],
    ['room_separator', 'line splitting rooms without a wall'],
    ['door', 'hosted on a wall: host_id, position, width, height'],
    ['window', 'hosted on a wall: host_id, position, width, height, base_offset (sill)'],
    ['opening', 'void in a wall / slab / roof'],
    ['stair', 'stair container (3D); parts below'],
    ['stair_run', 'flight of steps: host_id (stair)'],
    ['stair_landing', 'landing: host_id (stair)'],
    ['ramp', '3D line (start_z/end_z): width'],
    ['railing', '3D path or hosted on stair / slab edge'],
    ['furniture', 'library component (point): family, variant, rotation'],
  ]],
  ['Structure', [
    ['structure_wall', 'line: thickness'],
    ['structure_column', 'point: shape, size_x/size_y or designation'],
    ['structure_slab', 'polygon, top = level + base_offset: thickness'],
    ['beam', '3D line (absolute z = top): shape, size_x, size_y'],
    ['beam_system', 'parallel infill beams in a bay: spacing'],
    ['brace', '3D line: shape'],
    ['foundation', 'pad / pile / strip / raft / pile cap: kind, thickness'],
  ]],
  ['MEP', [
    ['duct', '3D line: shape, size_x/size_y, system_type, from/to'],
    ['pipe', '3D line: shape, size_x (diameter), system_type'],
    ['cable_tray', '3D line: size_x/size_y, system_type'],
    ['conduit', '3D line: size_x (diameter)'],
    ['equipment', 'point: equipment_type (AHU, pump, panel...); ports in connector'],
    ['terminal', 'point: terminal_type (diffuser, sink, WC, light...)'],
    ['mep_node', 'elbow / tee / fitting joining runs: kind'],
    ['connector', 'port on equipment / terminal / mep_node: host_id, name'],
    ['mep_system', 'system lookup: system_type'],
    ['circuit', 'electrical circuit from a panel: host_id'],
  ]],
  ['Types (global/; instances use type_id)', [
    ['wall_type', 'layers in type_layer'],
    ['slab_type', 'layered'],
    ['roof_type', 'layered'],
    ['ceiling_type', 'layered'],
    ['type_layer', 'one layer: type_id, seq, function, thickness'],
    ['door_type', 'width, height, operation'],
    ['window_type', 'width, height, operation, u_value'],
    ['curtain_wall_type', 'u/v spacing, mullions'],
    ['column_type', 'shape, sizes'],
    ['beam_type', 'shape, sizes'],
    ['foundation_type', 'kind, sizes'],
    ['furniture_type', 'family, variant, sizes'],
    ['railing_type', 'height, rails, infill'],
  ]],
  ['Annotation (level dirs)', [
    ['dimension', 'linear dimension: start/end x y'],
    ['text_note', 'text at x y'],
    ['tag', 'label of an element: host_id'],
    ['model_group', 'group instance: name, x y'],
  ]],
];

/** Compact index of every table (under 3k chars). */
export function schemaIndexLines(registry: Map<string, ResolvedTable>): string[] {
  const lines = ['Tables. Run `schema <table>` for exact columns, types, enums, references.'];
  const seen = new Set<string>();
  for (const [group, tables] of INDEX) {
    const present = tables.filter(([t]) => registry.has(t));
    if (present.length === 0) continue;
    lines.push(`${group}:`);
    for (const [t, purpose] of present) {
      seen.add(t);
      lines.push(`  ${t}: ${purpose}`);
    }
  }
  const other = [...registry.keys()].filter((t) => !seen.has(t)).sort();
  if (other.length > 0) lines.push(`Other: ${other.join(', ')}`);
  return lines;
}

/** Full schema of one table. */
export function schemaTableLines(resolved: ResolvedTable): string[] {
  const t = resolved.name;
  const lines = [`── ${t} (prefix: ${resolved.prefix}) ──`];
  if (resolved.hostType) lines.push(`  host_type: ${resolved.hostType}`);
  if (resolved.typeOf) {
    lines.push(`  type of: ${resolved.typeOf.join(', ')} (global/ only; instances inherit shared fields they leave empty)`);
  }
  if (resolved.typeTable) lines.push(`  type_id → ${resolved.typeTable}: empty shared fields inherit the type's values`);
  const typeParams = new Set(resolved.typeTable ? typeParamFields(t) : []);
  lines.push('  CSV fields:');
  for (const f of resolved.csvFields) {
    const tags: string[] = [];
    if (f.required) tags.push(typeParams.has(f.name) ? 'required unless type_id gives it' : 'required');
    if (f.type === 'reference') tags.push(`ref:${f.reference}`);
    if (f.type === 'enum') tags.push(`enum:[${f.values?.join('|')}]`);
    lines.push(`    ${f.name}: ${f.type}${tags.length > 0 ? `  (${tags.join(', ')})` : ''}`);
  }
  if (resolved.computedFields.length > 0) {
    lines.push('  Computed fields (derived from geometry; queryable, never written to CSV):');
    for (const f of resolved.computedFields) lines.push(`    ${f.name}: ${f.type}`);
  }
  if (t === 'furniture') lines.push(...furnitureCatalogLines());
  return lines;
}
