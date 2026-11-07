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
  /** Size in meters: plan width × depth, and height. */
  default_size: { w: number; d: number; h?: number };
  /** Mounting height (bottom above the level) used when the toolbar's Base Offset is 0. */
  default_base_offset?: string;
  /** Extra host attrs (design flow L/s, electrical load W). */
  extra?: Record<string, string>;
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

// Port helpers: rect duct port, round pipe port, electrical port.
type Dir = [number, number, number];
const duct = (name: string, offset: [number, number, number], dir: Dir, w: number, h: number, role: string, flow: 'in' | 'out'): StarterPort =>
  ({ name, offset, dir, shape: 'rect', size_w: w, size_h: h, system_role: role, flow_dir: flow, domain: 'hvac' });
const rduct = (name: string, offset: [number, number, number], dir: Dir, d: number, role: string, flow: 'in' | 'out'): StarterPort =>
  ({ name, offset, dir, shape: 'round', size_w: d, system_role: role, flow_dir: flow, domain: 'hvac' });
const pipe = (name: string, offset: [number, number, number], dir: Dir, d: number, role: string, flow: 'in' | 'out' | 'bidirectional'): StarterPort =>
  ({ name, offset, dir, shape: 'round', size_w: d, system_role: role, flow_dir: flow, domain: 'piping' });
const power = (offset: [number, number, number] = [0, 0, 0]): StarterPort =>
  ({ name: 'power_in', offset, dir: [0, 0, 1], shape: 'round', size_w: 0.02, system_role: 'power', flow_dir: 'in', domain: 'electrical' });

export const equipmentStarters: EquipmentStarter[] = [
  // ─── HVAC equipment ───────────────────────────────────────────
  {
    key: 'ahu_chw_2pipe', label_en: 'AHU (CHW coil, SA/RA/OA)', label_zh: 'AHU 组合式空调箱（冷冻水盘管）',
    table: 'equipment', type_enum: 'ahu', family: 'AHU - Generic 2-pipe', type: 'Standard',
    default_size: { w: 2.4, d: 1.2, h: 1.5 }, extra: { flow: '1500' },
    ports: [
      duct('sa', [-1.2, 0, 1.05], [-1, 0, 0], 0.8, 0.5, 'sa', 'out'),
      duct('ra', [1.2, 0.25, 1.05], [1, 0, 0], 0.6, 0.5, 'ra', 'in'),
      duct('oa', [1.2, -0.3, 0.45], [1, 0, 0], 0.5, 0.4, 'oa', 'in'),
      pipe('chws', [0.2, -0.6, 0.6], [0, -1, 0], 0.065, 'chw_supply', 'in'),
      pipe('chwr', [-0.2, -0.6, 0.6], [0, -1, 0], 0.065, 'chw_return', 'out'),
      pipe('condensate', [0, -0.6, 0.12], [0, -1, 0], 0.032, 'condensate', 'out'),
    ],
  },
  {
    key: 'fcu_chw_2pipe', label_en: 'FCU (ceiling, CHW 2-pipe)', label_zh: 'FCU 风机盘管（吊顶，冷冻水两管）',
    table: 'equipment', type_enum: 'fcu', family: 'FCU - Generic 2-pipe', type: 'Standard',
    default_size: { w: 1.0, d: 0.5, h: 0.3 }, default_base_offset: '2.8', extra: { flow: '200', load: '60' },
    ports: [
      duct('sa', [-0.5, 0, 0.15], [-1, 0, 0], 0.6, 0.15, 'sa', 'out'),
      duct('ra', [0.5, 0, 0.15], [1, 0, 0], 0.6, 0.15, 'ra', 'in'),
      pipe('chws', [0.35, -0.25, 0.15], [0, -1, 0], 0.02, 'chw_supply', 'in'),
      pipe('chwr', [0.2, -0.25, 0.15], [0, -1, 0], 0.02, 'chw_return', 'out'),
      pipe('condensate', [0.4, 0.25, 0.02], [0, 1, 0], 0.02, 'condensate', 'out'),
    ],
  },
  {
    key: 'vav_box', label_en: 'VAV Box', label_zh: 'VAV 变风量末端',
    table: 'equipment', type_enum: 'vav', family: 'VAV - Single duct', type: 'Standard',
    default_size: { w: 0.9, d: 0.45, h: 0.35 }, default_base_offset: '2.9', extra: { flow: '300' },
    ports: [
      rduct('inlet', [-0.45, 0, 0.175], [-1, 0, 0], 0.25, 'sa', 'in'),
      duct('outlet', [0.45, 0, 0.175], [1, 0, 0], 0.4, 0.25, 'sa', 'out'),
    ],
  },
  {
    key: 'pump_inline', label_en: 'Inline Pump', label_zh: '管道泵',
    table: 'equipment', type_enum: 'pump', family: 'Pump - Inline', type: 'Standard',
    default_size: { w: 0.6, d: 0.35, h: 0.6 }, extra: { load: '2200', flow: '10' },
    ports: [
      pipe('inlet', [-0.3, 0, 0.25], [-1, 0, 0], 0.08, 'chw_supply', 'in'),
      pipe('outlet', [0.3, 0, 0.25], [1, 0, 0], 0.08, 'chw_supply', 'out'),
    ],
  },
  {
    key: 'pump_end_suction', label_en: 'End-suction Pump', label_zh: '端吸泵',
    table: 'equipment', type_enum: 'pump', family: 'Pump - End suction', type: 'Standard',
    default_size: { w: 1.1, d: 0.45, h: 0.6 }, extra: { load: '5500', flow: '15' },
    ports: [
      pipe('inlet', [-0.55, 0, 0.3], [-1, 0, 0], 0.1, 'chw_return', 'in'),
      pipe('outlet', [0.15, 0, 0.6], [0, 0, 1], 0.08, 'chw_return', 'out'),
    ],
  },
  {
    key: 'chiller_aircooled', label_en: 'Air-cooled Chiller', label_zh: '风冷冷水机',
    table: 'equipment', type_enum: 'chiller', family: 'Chiller - Air-cooled', type: 'Standard',
    default_size: { w: 3.0, d: 1.5, h: 2.0 }, extra: { flow: '15', load: '60000' },
    ports: [
      pipe('chws', [-1.5, 0.3, 0.5], [-1, 0, 0], 0.1, 'chw_supply', 'out'),
      pipe('chwr', [-1.5, -0.3, 0.5], [-1, 0, 0], 0.1, 'chw_return', 'in'),
    ],
  },
  {
    key: 'chiller_watercooled', label_en: 'Water-cooled Chiller', label_zh: '水冷冷水机',
    table: 'equipment', type_enum: 'chiller', family: 'Chiller - Water-cooled', type: 'Standard',
    default_size: { w: 3.2, d: 1.3, h: 1.8 }, extra: { flow: '20', load: '90000' },
    ports: [
      pipe('chws', [-1.6, 0.3, 1.2], [-1, 0, 0], 0.125, 'chw_supply', 'out'),
      pipe('chwr', [-1.6, -0.3, 1.2], [-1, 0, 0], 0.125, 'chw_return', 'in'),
      pipe('cws', [1.6, 0.3, 0.6], [1, 0, 0], 0.15, 'cw_supply', 'in'),
      pipe('cwr', [1.6, -0.3, 0.6], [1, 0, 0], 0.15, 'cw_return', 'out'),
    ],
  },
  {
    key: 'boiler', label_en: 'Boiler', label_zh: '锅炉',
    table: 'equipment', type_enum: 'boiler', family: 'Boiler - Gas', type: 'Standard',
    default_size: { w: 1.2, d: 0.9, h: 1.5 }, extra: { flow: '5' },
    ports: [
      pipe('hws', [0.3, 0, 1.5], [0, 0, 1], 0.08, 'hw_supply', 'out'),
      pipe('hwr', [-0.6, 0, 0.4], [-1, 0, 0], 0.08, 'hw_return', 'in'),
      pipe('gas_in', [-0.6, 0.3, 0.2], [-1, 0, 0], 0.032, 'gas', 'in'),
    ],
  },
  {
    key: 'cooling_tower', label_en: 'Cooling Tower', label_zh: '冷却塔',
    table: 'equipment', type_enum: 'cooling_tower', family: 'Cooling Tower', type: 'Standard',
    default_size: { w: 3.0, d: 3.0, h: 3.5 }, extra: { flow: '25', load: '7500' },
    ports: [
      pipe('cwr', [-1.5, 0.5, 2.8], [-1, 0, 0], 0.15, 'cw_return', 'in'),
      pipe('cws', [-1.5, -0.5, 0.4], [-1, 0, 0], 0.15, 'cw_supply', 'out'),
      pipe('makeup', [1.5, 0, 0.6], [1, 0, 0], 0.04, 'dcw', 'in'),
    ],
  },
  {
    key: 'fan_inline', label_en: 'Inline Fan', label_zh: '管道风机',
    table: 'equipment', type_enum: 'fan', family: 'Fan - Inline', type: 'Standard',
    default_size: { w: 0.7, d: 0.6, h: 0.5 }, default_base_offset: '2.8', extra: { flow: '500', load: '750' },
    ports: [
      duct('inlet', [-0.35, 0, 0.25], [-1, 0, 0], 0.4, 0.3, 'ea', 'in'),
      duct('outlet', [0.35, 0, 0.25], [1, 0, 0], 0.4, 0.3, 'ea', 'out'),
    ],
  },
  {
    key: 'fan_roof_exhaust', label_en: 'Roof Exhaust Fan', label_zh: '屋顶排风机',
    table: 'equipment', type_enum: 'fan', family: 'Fan - Roof exhaust', type: 'Standard',
    default_size: { w: 0.9, d: 0.9, h: 0.7 }, extra: { flow: '800', load: '1100' },
    ports: [duct('inlet', [0, 0, 0], [0, 0, -1], 0.5, 0.5, 'ea', 'in')],
  },
  {
    key: 'water_heater', label_en: 'Water Heater', label_zh: '热水器',
    table: 'equipment', type_enum: 'water_heater', family: 'Water Heater - Storage', type: 'Standard',
    default_size: { w: 0.6, d: 0.6, h: 1.5 }, extra: { load: '3000' },
    ports: [
      pipe('cold_in', [0.15, 0, 1.5], [0, 0, 1], 0.025, 'dcw', 'in'),
      pipe('hot_out', [-0.15, 0, 1.5], [0, 0, 1], 0.025, 'dhw_supply', 'out'),
    ],
  },
  {
    key: 'panelboard', label_en: 'Panelboard', label_zh: '配电箱',
    table: 'equipment', type_enum: 'panelboard', family: 'Panelboard', type: '230/400V',
    default_size: { w: 0.6, d: 0.2, h: 1.0 }, default_base_offset: '0.5',
    ports: [],
  },
  // ─── Air terminals ────────────────────────────────────────────
  {
    key: 'diffuser_supply', label_en: 'Supply Air Diffuser', label_zh: '送风口（散流器）',
    table: 'terminal', type_enum: 'supply_air_diffuser', family: 'Diffuser - Square', type: '600x600',
    default_size: { w: 0.6, d: 0.6, h: 0.05 }, default_base_offset: '2.7', extra: { flow: '100' },
    ports: [duct('inlet', [0, 0, 0.05], [0, 0, 1], 0.3, 0.3, 'sa', 'in')],
  },
  {
    key: 'grille_return', label_en: 'Return Air Grille', label_zh: '回风口',
    table: 'terminal', type_enum: 'return_air_grille', family: 'Grille - Return', type: '600x600',
    default_size: { w: 0.6, d: 0.6, h: 0.05 }, default_base_offset: '2.7', extra: { flow: '100' },
    ports: [duct('outlet', [0, 0, 0.05], [0, 0, 1], 0.4, 0.4, 'ra', 'out')],
  },
  {
    key: 'grille_exhaust', label_en: 'Exhaust Air Grille', label_zh: '排风口',
    table: 'terminal', type_enum: 'exhaust_air_grille', family: 'Grille - Exhaust', type: '300x300',
    default_size: { w: 0.3, d: 0.3, h: 0.05 }, default_base_offset: '2.7', extra: { flow: '50' },
    ports: [duct('outlet', [0, 0, 0.05], [0, 0, 1], 0.2, 0.2, 'ea', 'out')],
  },
  // ─── Fire protection ──────────────────────────────────────────
  {
    key: 'sprinkler_pendent', label_en: 'Sprinkler Head (pendent)', label_zh: '喷淋头（下垂型）',
    table: 'terminal', type_enum: 'sprinkler_head', family: 'Sprinkler - Pendent', type: 'K80',
    default_size: { w: 0.08, d: 0.08, h: 0.08 }, default_base_offset: '2.75', extra: { flow: '1.33' },
    ports: [pipe('inlet', [0, 0, 0.08], [0, 0, 1], 0.025, 'fp_supply', 'in')],
  },
  // ─── Plumbing fixtures ────────────────────────────────────────
  {
    key: 'water_closet', label_en: 'Water Closet', label_zh: '坐便器',
    table: 'terminal', type_enum: 'water_closet', family: 'WC - Floor mounted', type: 'Standard',
    default_size: { w: 0.4, d: 0.7, h: 0.8 }, extra: { flow: '0.1' },
    ports: [
      pipe('cold_in', [0.12, -0.35, 0.25], [0, -1, 0], 0.015, 'dcw', 'in'),
      pipe('drain', [0, -0.1, 0], [0, 0, -1], 0.1, 'drain', 'out'),
    ],
  },
  {
    key: 'urinal', label_en: 'Urinal', label_zh: '小便器',
    table: 'terminal', type_enum: 'urinal', family: 'Urinal - Wall hung', type: 'Standard',
    default_size: { w: 0.4, d: 0.35, h: 0.7 }, extra: { flow: '0.1' },
    ports: [
      pipe('cold_in', [0, -0.175, 1.1], [0, -1, 0], 0.015, 'dcw', 'in'),
      pipe('drain', [0, -0.1, 0.45], [0, 0, -1], 0.05, 'drain', 'out'),
    ],
  },
  {
    key: 'lavatory', label_en: 'Lavatory (wash basin)', label_zh: '洗手盆',
    table: 'terminal', type_enum: 'lavatory', family: 'Lavatory - Wall hung', type: 'Standard',
    default_size: { w: 0.55, d: 0.45, h: 0.85 }, extra: { flow: '0.1' },
    ports: [
      pipe('cold_in', [0.1, -0.225, 0.55], [0, -1, 0], 0.015, 'dcw', 'in'),
      pipe('hot_in', [-0.1, -0.225, 0.55], [0, -1, 0], 0.015, 'dhw_supply', 'in'),
      pipe('drain', [0, -0.05, 0.45], [0, 0, -1], 0.04, 'drain', 'out'),
    ],
  },
  {
    key: 'sink', label_en: 'Sink', label_zh: '洗涤盆',
    table: 'terminal', type_enum: 'sink', family: 'Sink - Kitchen', type: 'Single bowl',
    default_size: { w: 0.8, d: 0.5, h: 0.9 }, extra: { flow: '0.2' },
    ports: [
      pipe('cold_in', [0.1, -0.25, 0.55], [0, -1, 0], 0.015, 'dcw', 'in'),
      pipe('hot_in', [-0.1, -0.25, 0.55], [0, -1, 0], 0.015, 'dhw_supply', 'in'),
      pipe('drain', [0, -0.05, 0.45], [0, 0, -1], 0.05, 'drain', 'out'),
    ],
  },
  {
    key: 'shower', label_en: 'Shower', label_zh: '淋浴',
    table: 'terminal', type_enum: 'shower', family: 'Shower - Tray', type: '900x900',
    default_size: { w: 0.9, d: 0.9, h: 0.05 }, extra: { flow: '0.15' },
    ports: [
      pipe('cold_in', [0.1, -0.45, 1.0], [0, -1, 0], 0.015, 'dcw', 'in'),
      pipe('hot_in', [-0.1, -0.45, 1.0], [0, -1, 0], 0.015, 'dhw_supply', 'in'),
      pipe('drain', [0, 0, 0], [0, 0, -1], 0.05, 'drain', 'out'),
    ],
  },
  {
    key: 'floor_drain', label_en: 'Floor Drain', label_zh: '地漏',
    table: 'terminal', type_enum: 'floor_drain', family: 'Floor Drain', type: 'DN50',
    default_size: { w: 0.15, d: 0.15, h: 0.02 },
    ports: [pipe('drain', [0, 0, 0], [0, 0, -1], 0.05, 'drain', 'out')],
  },
  // ─── Electrical devices ───────────────────────────────────────
  {
    key: 'light_troffer', label_en: 'Light Fixture (1200×600)', label_zh: '灯具（格栅灯 1200×600）',
    table: 'terminal', type_enum: 'light_fixture', family: 'Light - Troffer', type: '1200x600 LED',
    default_size: { w: 1.2, d: 0.6, h: 0.1 }, default_base_offset: '2.7', extra: { load: '36' },
    ports: [power([0, 0, 0.1])],
  },
  {
    key: 'light_downlight', label_en: 'Downlight', label_zh: '筒灯',
    table: 'terminal', type_enum: 'light_fixture', family: 'Light - Downlight', type: 'LED 12W',
    default_size: { w: 0.2, d: 0.2, h: 0.15 }, default_base_offset: '2.7', extra: { load: '12' },
    ports: [power([0, 0, 0.15])],
  },
  {
    key: 'emergency_light', label_en: 'Emergency Light', label_zh: '应急灯',
    table: 'terminal', type_enum: 'emergency_light', family: 'Light - Emergency', type: 'LED 5W',
    default_size: { w: 0.35, d: 0.15, h: 0.1 }, default_base_offset: '2.5', extra: { load: '5' },
    ports: [power([0, 0, 0.1])],
  },
  {
    key: 'receptacle', label_en: 'Receptacle', label_zh: '插座',
    table: 'terminal', type_enum: 'power_outlet', family: 'Receptacle - Duplex', type: '16A',
    default_size: { w: 0.09, d: 0.09, h: 0.09 }, default_base_offset: '0.3', extra: { load: '180' },
    ports: [power()],
  },
  {
    key: 'light_switch', label_en: 'Light Switch', label_zh: '开关',
    table: 'terminal', type_enum: 'switch', family: 'Switch - Single pole', type: '10A',
    default_size: { w: 0.09, d: 0.09, h: 0.09 }, default_base_offset: '1.3',
    ports: [power()],
  },
  {
    key: 'data_outlet', label_en: 'Data Outlet', label_zh: '信息插座',
    table: 'terminal', type_enum: 'data_outlet', family: 'Data Outlet', type: 'RJ45 x2',
    default_size: { w: 0.09, d: 0.09, h: 0.09 }, default_base_offset: '0.3',
    ports: [],
  },
  {
    key: 'junction_box', label_en: 'Junction Box', label_zh: '接线盒',
    table: 'terminal', type_enum: 'junction_box', family: 'Junction Box', type: '100x100',
    default_size: { w: 0.1, d: 0.1, h: 0.06 }, default_base_offset: '2.8',
    ports: [power()],
  },
  {
    key: 'smoke_detector', label_en: 'Smoke Detector', label_zh: '感烟探测器',
    table: 'terminal', type_enum: 'fire_alarm_device', family: 'Smoke Detector', type: 'Photoelectric',
    default_size: { w: 0.12, d: 0.12, h: 0.05 }, default_base_offset: '2.75', extra: { load: '1' },
    ports: [],
  },
];

/** Height above the level: the toolbar's Base Offset, or the template's
 *  mounting height when the toolbar is left at 0 (diffusers at the ceiling,
 *  receptacles at 0.3 m). */
export function starterBaseOffset(starter: EquipmentStarter, toolbar: string | undefined): string {
  const v = parseFloat(toolbar ?? '');
  if (Number.isFinite(v) && v !== 0) return String(v);
  return starter.default_base_offset ?? (Number.isFinite(v) ? String(v) : '0');
}

/** Plumbing fixtures the architecture library offers (Revit "Plumbing Fixtures"):
 *  placed as MEP terminals with their ports, so MEP can connect them later. */
export const SANITARY_STARTER_KEYS = ['water_closet', 'urinal', 'lavatory', 'sink', 'shower', 'floor_drain'];

/** Terminal types drawn in the architecture view too (sanitary fixtures belong to architectural plans). */
export const SANITARY_TERMINAL_TYPES = new Set(['water_closet', 'urinal', 'lavatory', 'sink', 'shower', 'floor_drain', 'plumbing_fixture']);

export function isSanitaryFixture(el: { tableName: string; attrs: Record<string, string> }): boolean {
  return el.tableName === 'terminal' && SANITARY_TERMINAL_TYPES.has(el.attrs.terminal_type ?? '');
}

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
  /** Height above the level (the toolbar's Base Offset); default from the table. */
  baseOffset?: string,
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
  hostAttrs.base_offset = starterBaseOffset(starter, baseOffset);
  if (starter.default_size.h) hostAttrs.height = String(starter.default_size.h);
  Object.assign(hostAttrs, starter.extra ?? {});
  // A host whose ports are all on one system joins it (a supply diffuser is
  // on SA), so it is coloured and filtered with that system.
  const roles = new Set(starter.ports.filter(p => p.domain !== 'electrical').map(p => p.system_role));
  if (!hostAttrs.system_type && roles.size >= 1) hostAttrs.system_type = [...roles].map(resolveSystemTag).join(',');
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
