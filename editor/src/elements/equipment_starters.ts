/**
 * Equipment starter templates.
 *
 * NOT part of the BimDown spec — purely an editor-side convenience library
 * that materializes into plain `equipment` (or `terminal`) rows plus a set of
 * `connector` rows so the user doesn't have to author each port by hand.
 *
 * The data emitted by the materializer is fully spec-compliant; nothing here
 * gets persisted as "this instance came from starter X". Same-template
 * instances are independent rows. Editing the template later does not
 * propagate. Use "Duplicate" on a placed instance to clone a configured one.
 *
 * Port offsets are in meters, local to the host frame (host origin = 0,0,0
 * before rotation). Outward direction (`dir`) is a unit vector in the host
 * local frame.
 */
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { generateId } from '../model/ids.ts';

export interface StarterPort {
  name: string;
  offset: [number, number, number];
  dir: [number, number, number];
  shape: 'round' | 'rect';
  size_w: number;
  size_h?: number;
  /** Semantic role mapped to a project-specific system_type tag at
   *  materialization time (e.g. chw_supply → "CHWS"). */
  system_role: string;
  flow_dir: 'in' | 'out' | 'bidirectional';
  domain: 'hvac' | 'piping' | 'electrical' | 'cable_tray_conduit';
}

export interface EquipmentStarter {
  key: string;
  /** Display labels (English + Chinese). The UI picks one based on locale. */
  label_en: string;
  label_zh: string;
  /** Which table to create — equipment or terminal. */
  table: 'equipment' | 'terminal';
  /** Category enum on the host row (equipment_type or terminal_type). */
  type_enum: string;
  /** Free-form family/type strings for round-trip with Revit. */
  family: string;
  type: string;
  /** Footprint in meters: width × depth (height stays default). */
  default_size: { w: number; d: number };
  /** Default rotation in degrees. */
  default_rotation?: number;
  ports: StarterPort[];
}

/** Map a port's `system_role` to a project-specific system tag.
 *  For the starter library we ship a sensible default mapping that the
 *  current `mep_system.csv` rows will usually contain. Users with custom
 *  tags should set the connector row's system_type afterwards. */
const ROLE_TO_SYSTEM_TAG: Record<string, string> = {
  chw_supply: 'CHWS',
  chw_return: 'CHWR',
  cw_supply: 'CWS',
  cw_return: 'CWR',
  hw_supply: 'HWS',
  hw_return: 'HWR',
  dhw_supply: 'DHWS',
  dhw_recirc: 'DHWR',
  dcw: 'DCW',
  sa: 'SA',
  ra: 'RA',
  ea: 'EA',
  oa: 'OA',
  drain: 'SAN',
  vent: 'V',
  condensate: 'CD',
  gas: 'G',
  fp_supply: 'FP',
  power: 'PWR',
  data: 'DATA',
};

export const equipmentStarters: EquipmentStarter[] = [
  // ─── HVAC equipment ───────────────────────────────────────────
  {
    key: 'ahu_chw_2pipe',
    label_en: 'AHU (CHW 2-pipe + SA/RA)',
    label_zh: 'AHU 冷冻水双管 + 送回风',
    table: 'equipment',
    type_enum: 'ahu',
    family: 'AHU - Generic 2-pipe',
    type: 'Standard',
    default_size: { w: 1.6, d: 0.9 },
    ports: [
      { name: 'chws',  offset: [ 0.8,  0.2, 0.3], dir: [ 1, 0, 0], shape: 'round', size_w: 0.10, system_role: 'chw_supply',  flow_dir: 'in',  domain: 'piping' },
      { name: 'chwr',  offset: [ 0.8, -0.2, 0.3], dir: [ 1, 0, 0], shape: 'round', size_w: 0.10, system_role: 'chw_return',  flow_dir: 'out', domain: 'piping' },
      { name: 'sa',    offset: [-0.8,  0.0, 0.3], dir: [-1, 0, 0], shape: 'rect',  size_w: 0.60, size_h: 0.40, system_role: 'sa', flow_dir: 'out', domain: 'hvac' },
      { name: 'ra',    offset: [ 0.0, -0.45, 0.3], dir: [ 0, -1, 0], shape: 'rect', size_w: 0.50, size_h: 0.40, system_role: 'ra', flow_dir: 'in', domain: 'hvac' },
      { name: 'condensate', offset: [0.6, -0.3, 0.0], dir: [0, 0, -1], shape: 'round', size_w: 0.025, system_role: 'condensate', flow_dir: 'out', domain: 'piping' },
    ],
  },
  {
    key: 'fcu_chw_2pipe',
    label_en: 'FCU (CHW 2-pipe)',
    label_zh: 'FCU 冷冻水双管',
    table: 'equipment',
    type_enum: 'fcu',
    family: 'FCU - Generic 2-pipe',
    type: 'Standard',
    default_size: { w: 0.9, d: 0.5 },
    ports: [
      { name: 'chws',   offset: [ 0.45,  0.1, 0.2], dir: [ 1, 0, 0], shape: 'round', size_w: 0.025, system_role: 'chw_supply', flow_dir: 'in',  domain: 'piping' },
      { name: 'chwr',   offset: [ 0.45, -0.1, 0.2], dir: [ 1, 0, 0], shape: 'round', size_w: 0.025, system_role: 'chw_return', flow_dir: 'out', domain: 'piping' },
      { name: 'sa',     offset: [-0.45, 0.0, 0.2], dir: [-1, 0, 0], shape: 'rect',  size_w: 0.30, size_h: 0.20, system_role: 'sa', flow_dir: 'out', domain: 'hvac' },
      { name: 'condensate', offset: [0.0, -0.25, 0.0], dir: [0, 0, -1], shape: 'round', size_w: 0.020, system_role: 'condensate', flow_dir: 'out', domain: 'piping' },
    ],
  },
  {
    key: 'vav_box',
    label_en: 'VAV Box',
    label_zh: 'VAV 风量调节箱',
    table: 'equipment',
    type_enum: 'fcu',
    family: 'VAV - Standard',
    type: 'Standard',
    default_size: { w: 0.8, d: 0.4 },
    ports: [
      { name: 'inlet',  offset: [-0.4, 0.0, 0.2], dir: [-1, 0, 0], shape: 'rect', size_w: 0.30, size_h: 0.20, system_role: 'sa', flow_dir: 'in',  domain: 'hvac' },
      { name: 'outlet', offset: [ 0.4, 0.0, 0.2], dir: [ 1, 0, 0], shape: 'rect', size_w: 0.30, size_h: 0.20, system_role: 'sa', flow_dir: 'out', domain: 'hvac' },
    ],
  },
  {
    key: 'pump_inline',
    label_en: 'Inline Pump',
    label_zh: '管道泵',
    table: 'equipment',
    type_enum: 'pump',
    family: 'Pump - Inline',
    type: 'Standard',
    default_size: { w: 0.5, d: 0.3 },
    ports: [
      { name: 'inlet',  offset: [-0.25, 0.0, 0.15], dir: [-1, 0, 0], shape: 'round', size_w: 0.05, system_role: 'chw_supply', flow_dir: 'in',  domain: 'piping' },
      { name: 'outlet', offset: [ 0.25, 0.0, 0.15], dir: [ 1, 0, 0], shape: 'round', size_w: 0.05, system_role: 'chw_supply', flow_dir: 'out', domain: 'piping' },
    ],
  },
  {
    key: 'chiller_aircooled',
    label_en: 'Air-cooled Chiller',
    label_zh: '风冷冷水机',
    table: 'equipment',
    type_enum: 'chiller',
    family: 'Chiller - Air-cooled',
    type: 'Standard',
    default_size: { w: 3.0, d: 1.5 },
    ports: [
      { name: 'chws', offset: [-1.5,  0.3, 0.5], dir: [-1, 0, 0], shape: 'round', size_w: 0.15, system_role: 'chw_supply', flow_dir: 'out', domain: 'piping' },
      { name: 'chwr', offset: [-1.5, -0.3, 0.5], dir: [-1, 0, 0], shape: 'round', size_w: 0.15, system_role: 'chw_return', flow_dir: 'in',  domain: 'piping' },
    ],
  },
  // ─── Terminals ────────────────────────────────────────────────
  {
    key: 'diffuser_supply',
    label_en: 'Supply Air Diffuser',
    label_zh: '送风口',
    table: 'terminal',
    type_enum: 'supply_air_diffuser',
    family: 'Diffuser - Square',
    type: 'Standard',
    default_size: { w: 0.3, d: 0.3 },
    ports: [
      { name: 'inlet', offset: [0, 0, 0.0], dir: [0, 0, 1], shape: 'rect', size_w: 0.25, size_h: 0.25, system_role: 'sa', flow_dir: 'in', domain: 'hvac' },
    ],
  },
  {
    key: 'grille_return',
    label_en: 'Return Air Grille',
    label_zh: '回风口',
    table: 'terminal',
    type_enum: 'return_air_grille',
    family: 'Grille - Return',
    type: 'Standard',
    default_size: { w: 0.4, d: 0.3 },
    ports: [
      { name: 'outlet', offset: [0, 0, 0.0], dir: [0, 0, 1], shape: 'rect', size_w: 0.35, size_h: 0.25, system_role: 'ra', flow_dir: 'out', domain: 'hvac' },
    ],
  },
];

/** Quick lookup by starter key. */
export function getStarter(key: string | undefined | null): EquipmentStarter | null {
  if (!key) return null;
  return equipmentStarters.find((s) => s.key === key) ?? null;
}

/** Resolve a starter's port `system_role` to an actual `system_type` tag.
 *  Returns the role's default tag when no project-side mapping is available. */
export function resolveSystemTag(role: string): string {
  return ROLE_TO_SYSTEM_TAG[role] ?? role.toUpperCase();
}

/** Materialize a starter at the given world-space position.
 *  Produces the host row + N connector rows ready to dispatch through
 *  CREATE_ELEMENTS. The host id and connector ids are freshly allocated
 *  against the supplied `existingIds` set (which is mutated to reserve them).
 *  The discipline is derived from the table — both equipment and terminal
 *  live under "mep". */
export function materializeStarter(
  starter: EquipmentStarter,
  position: { x: number; y: number },
  levelId: string,
  existingIds: Set<string>,
  /** Optional explicit rotation override. Default: starter.default_rotation ?? 0. */
  rotationDegOverride?: number,
): CanonicalElement[] {
  const out: CanonicalElement[] = [];

  // ── Host row ──
  const hostId = generateId(starter.table, existingIds);
  existingIds.add(hostId);
  const baseHostAttrs = defaultAttrs(starter.table, levelId);
  const rotationDeg = rotationDegOverride ?? starter.default_rotation ?? 0;
  const hostTypeKey = starter.table === 'equipment' ? 'equipment_type' : 'terminal_type';
  const hostAttrs: Record<string, string> = {
    ...baseHostAttrs,
    id: hostId,
    [hostTypeKey]: starter.type_enum,
    family: starter.family,
    type: starter.type,
    rotation: String(rotationDeg),
    // Strip any sentinel/UI-only keys that callers may have leaked through.
  };
  // Drop the __starter_key sentinel from the persisted attrs.
  delete hostAttrs.__starter_key;

  const host: PointElement = {
    id: hostId,
    tableName: starter.table,
    discipline: 'mep',
    geometry: 'point',
    position: { x: position.x, y: position.y },
    width: starter.default_size.w,
    height: starter.default_size.d,
    attrs: hostAttrs,
  };
  out.push(host);

  // ── Connector rows ──
  for (const port of starter.ports) {
    const cid = generateId('connector', existingIds);
    existingIds.add(cid);
    const baseConnAttrs = defaultAttrs('connector', levelId);
    const connAttrs: Record<string, string> = {
      ...baseConnAttrs,
      id: cid,
      host_id: hostId,
      name: port.name,
      offset_x: String(port.offset[0]),
      offset_y: String(port.offset[1]),
      offset_z: String(port.offset[2]),
      dir_x: String(port.dir[0]),
      dir_y: String(port.dir[1]),
      dir_z: String(port.dir[2]),
      shape: port.shape,
      size_w: String(port.size_w),
      size_h: port.size_h !== undefined ? String(port.size_h) : '',
      system_type: resolveSystemTag(port.system_role),
      flow_dir: port.flow_dir,
      domain: port.domain,
    };

    // Connector geometry is "hosted point" — derived at render time from
    // host position + offset. We still emit a position so layer-based hit
    // testing has something to fall back on; the connector module's
    // geometry() recomputes the authoritative position each frame.
    const cos = Math.cos((rotationDeg * Math.PI) / 180);
    const sin = Math.sin((rotationDeg * Math.PI) / 180);
    const wx = position.x + port.offset[0] * cos - port.offset[1] * sin;
    const wy = position.y + port.offset[0] * sin + port.offset[1] * cos;

    const connector: PointElement = {
      id: cid,
      tableName: 'connector',
      discipline: 'mep',
      geometry: 'point',
      position: { x: wx, y: wy },
      width: 0,
      height: 0,
      hostId,
      attrs: connAttrs,
    };
    out.push(connector);
  }

  return out;
}
