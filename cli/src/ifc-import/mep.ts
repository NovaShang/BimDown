/**
 * MEP: flow segments → duct / pipe / cable_tray / conduit (3D centre line
 * between the two ports, or along the extrusion / principal axis), fittings
 * and accessories → mep_node, terminals and equipment → points with a size
 * box, IfcSystem membership → system_type + global/mep_system.csv.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc lines are untyped */
import type { ImportContext, OutEl, AttrValue } from './context.js';
import { type WorldMesh, planObb, sectionExtents } from './geometry.js';
import { enumValue, str } from './model.js';
import { type V3, add3, angleDeg, apply, dist2, len3, norm3, r3, scale3, sub3 } from './math.js';
import { memberAxis } from './structure.js';

export type SegmentTable = 'duct' | 'pipe' | 'cable_tray' | 'conduit';

const SYSTEM_CLASSES = new Set(['IfcSystem', 'IfcDistributionSystem', 'IfcDistributionCircuit', 'IfcBuildingSystem']);

/** What an IfcFlowSegment (or IFC4 subtype) carries. */
export function segmentTable(ctx: ImportContext, id: number): SegmentTable | null {
  const { model } = ctx;
  const cls = model.className(id);
  const t = model.typeOf.get(id);
  const tcls = t ? model.className(t) : '';
  const pt = enumValue(model.line(id)?.PredefinedType) ?? (t ? enumValue(model.line(t)?.PredefinedType) : null) ?? '';
  if (cls === 'IfcDuctSegment' || tcls === 'IfcDuctSegmentType') return 'duct';
  if (cls === 'IfcPipeSegment' || tcls === 'IfcPipeSegmentType') return 'pipe';
  if (cls === 'IfcCableCarrierSegment' || tcls === 'IfcCableCarrierSegmentType') return pt === 'CONDUITSEGMENT' ? 'conduit' : 'cable_tray';
  const name = `${str(model.line(id)?.Name) ?? ''} ${str(model.line(id)?.ObjectType) ?? ''} ${t ? str(model.line(t)?.Name) ?? '' : ''}`.toLowerCase();
  if (/conduit|leerrohr|\bemt\b|\bimc\b|\brmc\b/.test(name)) return 'conduit';
  if (/tray|trasse|pritsche|kabelrinne|ladder/.test(name)) return 'cable_tray';
  // Wires / cables themselves are not modelled
  if (cls === 'IfcCableSegment' || tcls === 'IfcCableSegmentType') return null;
  if (/duct|kanal|luft|air|lüftung|wickelfalz/.test(name)) return 'duct';
  if (/pipe|rohr|leitung|tube/.test(name)) return 'pipe';
  return 'pipe';
}

/** Systems an element belongs to (first distribution system name), registering mep_system rows. */
export class Systems {
  private rows = new Map<string, OutEl>();
  constructor(private ctx: ImportContext) {}

  systemOf(id: number, discipline: string): string | undefined {
    const { model } = this.ctx;
    for (const g of model.groups.get(id) ?? []) {
      if (!SYSTEM_CLASSES.has(model.className(g))) continue;
      const line = model.line(g);
      const tag = (str(line?.Name) ?? str(line?.LongName) ?? '').slice(0, 60);
      if (!tag) continue;
      if (!this.rows.has(tag)) {
        const row = this.ctx.add('mep_system', 0, 0, { system_type: tag, name: str(line?.Description) ?? str(line?.ObjectType) ?? tag, discipline }, null);
        row.global = true;
        this.rows.set(tag, row);
      }
      return tag;
    }
    return undefined;
  }
}

function portPosition(ctx: ImportContext, port: number): V3 | null {
  const m = ctx.model.productMatrix(port);
  return m ? apply(m, 0, 0, 0) : null;
}

const DISCIPLINE: Record<SegmentTable, string> = { duct: 'hvac', pipe: 'plumbing', cable_tray: 'electrical', conduit: 'electrical' };

export function convertSegment(ctx: ImportContext, systems: Systems, id: number, table: SegmentTable): OutEl | null {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const axis = memberAxis(ctx, id, mesh);
  if (!axis) { ctx.skip(id, 'no usable geometry'); return null; }
  const ports = (ctx.model.ports.get(id) ?? []).map(p => portPosition(ctx, p)).filter((p): p is V3 => !!p);
  let dir = axis.dir;
  let a: V3, b: V3;
  const sec0 = sectionExtents(mesh, axis.origin, dir);
  if (ports.length === 2 && len3(sub3(ports[1], ports[0])) > 0.01) {
    [a, b] = ports;
    dir = norm3(sub3(b, a));
  } else {
    const c = add3(axis.origin, add3(scale3(sideOf(dir), sec0.du), scale3(upOf(dir), sec0.dv)));
    a = add3(c, scale3(dir, sec0.t0));
    b = add3(c, scale3(dir, sec0.t1));
  }
  if (len3(sub3(b, a)) < 0.01) { ctx.skip(id, 'too short'); return null; }
  const sec = sectionExtents(mesh, a, dir);
  const prof = axis.profile;
  const round = prof?.kind === 'circle' || (!prof && table !== 'duct' && table !== 'cable_tray') ||
    (!prof && Math.abs(sec.width - sec.height) < 0.002 && /rund|round|circ|spiral|wickelfalz/i.test(ctx.label(id) ?? ''));
  const level = ctx.levelOf(id, Math.min(a.z, b.z));
  const attrs: Record<string, AttrValue> = { number: ctx.label(id) };
  if (round) {
    attrs.shape = 'round';
    attrs.size_x = r3(prof?.kind === 'circle' ? prof.r * 2 : Math.max(sec.width, sec.height));
  } else {
    attrs.shape = 'rect';
    attrs.size_x = r3(sec.width);
    attrs.size_y = r3(sec.height);
  }
  attrs.system_type = systems.systemOf(id, DISCIPLINE[table]);
  return ctx.add(table, id, level, attrs, { type: 'LineString', coordinates: [[r3(a.x), r3(a.y), r3(a.z)], [r3(b.x), r3(b.y), r3(b.z)]] });
}

function sideOf(d: V3): V3 {
  const u = { x: -d.y, y: d.x, z: 0 };
  return Math.hypot(u.x, u.y) < 1e-6 ? { x: 1, y: 0, z: 0 } : norm3(u);
}

function upOf(d: V3): V3 {
  const s = sideOf(d);
  return norm3({ x: d.y * s.z - d.z * s.y, y: d.z * s.x - d.x * s.z, z: d.x * s.y - d.y * s.x });
}

// ─── Point elements ──────────────────────────────────────────────────────────

/** Point at the bottom centre of the body with its box size and plan rotation. */
function boxPoint(mesh: WorldMesh): { coordinates: [number, number, number]; size: number[]; rotation: number } {
  const obb = planObb(mesh);
  const cx = obb ? obb.center.x : (mesh.min.x + mesh.max.x) / 2, cy = obb ? obb.center.y : (mesh.min.y + mesh.max.y) / 2;
  let w = obb ? obb.length : mesh.max.x - mesh.min.x, d = obb ? obb.width : mesh.max.y - mesh.min.y;
  let rot = obb ? angleDeg(obb.u) : 0;
  // Keep the rotation within ±45° by swapping the sides
  if (Math.abs(rot) > 45 && Math.abs(rot) < 135) { rot -= Math.sign(rot) * 90; [w, d] = [d, w]; }
  if (Math.abs(rot) >= 135) rot -= Math.sign(rot) * 180;
  return { coordinates: [r3(cx), r3(cy), r3(mesh.min.z)], size: [r3(w), r3(d), r3(mesh.max.z - mesh.min.z)], rotation: Math.round(rot * 100) / 100 };
}

function pointProps(bp: ReturnType<typeof boxPoint>): Record<string, unknown> {
  const props: Record<string, unknown> = { size: bp.size };
  if (Math.abs(bp.rotation) >= 0.05) props.rotation = bp.rotation;
  return props;
}

const TERMINAL_CLASS: Record<string, string> = {
  IfcSanitaryTerminal: 'plumbing_fixture', IfcWasteTerminal: 'plumbing_fixture', IfcStackTerminal: 'plumbing_fixture',
  IfcLightFixture: 'light_fixture', IfcLamp: 'light_fixture', IfcFireSuppressionTerminal: 'sprinkler_head',
  IfcAlarm: 'fire_alarm_device', IfcElectricAppliance: 'other', IfcCommunicationsAppliance: 'data_outlet',
};

function terminalType(ctx: ImportContext, id: number, system: string | undefined): string {
  const { model } = ctx;
  const cls = model.className(id);
  const t = model.typeOf.get(id);
  const tcls = t ? model.className(t).replace(/Type$|Style$/, '') : '';
  const pt = enumValue(model.line(id)?.PredefinedType) ?? (t ? enumValue(model.line(t)?.PredefinedType) : null) ?? '';
  const name = `${ctx.label(id) ?? ''} ${system ?? ''}`.toLowerCase();
  const k = cls !== 'IfcFlowTerminal' ? cls : tcls;
  if (k === 'IfcAirTerminal' || /diffus|grill|register|auslass|durchlass|luftdurch|ventil.*luft|air terminal/.test(name)) {
    if (/exhaust|abluft|fortluft|extract/.test(name)) return 'exhaust_air_grille';
    if (/return|rückluft|ruckluft|umluft/.test(name) || pt === 'GRILLE') return 'return_air_grille';
    return 'supply_air_diffuser';
  }
  if (k === 'IfcOutlet') return pt === 'DATAOUTLET' || pt === 'TELEPHONEOUTLET' || pt === 'AUDIOVISUALOUTLET' || /data|netz|lan|rj45/.test(name) ? 'data_outlet' : 'power_outlet';
  if (k === 'IfcFireSuppressionTerminal' && pt !== 'SPRINKLER' && pt !== '') return 'other';
  if (TERMINAL_CLASS[k]) return TERMINAL_CLASS[k];
  if (/sprinkler/.test(name)) return 'sprinkler_head';
  if (/light|leuchte|lamp/.test(name)) return 'light_fixture';
  if (/wc|toilet|sink|basin|waschtisch|urinal|shower|dusche|bath|wanne|spül|lavatory/.test(name)) return 'plumbing_fixture';
  if (/outlet|steckdose|socket|receptacle/.test(name)) return 'power_outlet';
  return 'other';
}

const EQUIPMENT_CLASS: Record<string, string> = {
  IfcBoiler: 'boiler', IfcChiller: 'chiller', IfcCoolingTower: 'cooling_tower', IfcFan: 'fan', IfcPump: 'pump',
  IfcTank: 'tank', IfcTransformer: 'transformer', IfcElectricDistributionBoard: 'panelboard', IfcElectricGenerator: 'generator',
};

function equipmentType(ctx: ImportContext, id: number): string {
  const { model } = ctx;
  const cls = model.className(id);
  const t = model.typeOf.get(id);
  const tcls = t ? model.className(t).replace(/Type$/, '') : '';
  const k = EQUIPMENT_CLASS[cls] ? cls : tcls;
  const pt = enumValue(model.line(id)?.PredefinedType) ?? (t ? enumValue(model.line(t)?.PredefinedType) : null) ?? '';
  if (EQUIPMENT_CLASS[k]) return k === 'IfcBoiler' && pt === 'WATER' ? 'water_heater' : EQUIPMENT_CLASS[k];
  if (k === 'IfcUnitaryEquipment') return pt === 'AIRHANDLER' ? 'ahu' : 'fcu';
  const name = (ctx.label(id) ?? '').toLowerCase();
  if (/\bahu\b|air.?handl|rlt|lüftungsgerät|klimagerät|wrg/.test(name)) return 'ahu';
  if (/fan.?coil|\bfcu\b|gebläsekonvektor/.test(name)) return 'fcu';
  if (/chiller|kälte|kaelte/.test(name)) return 'chiller';
  if (/boiler|kessel|heizkessel/.test(name)) return 'boiler';
  if (/water.?heater|warmwasser|boiler.*ww/.test(name)) return 'water_heater';
  if (/pump|pumpe/.test(name)) return 'pump';
  if (/\bfan\b|ventilator/.test(name)) return 'fan';
  if (/tank|speicher|behälter/.test(name)) return 'tank';
  if (/transformer|trafo/.test(name)) return 'transformer';
  if (/panel|verteiler|distribution board|switchboard/.test(name)) return 'panelboard';
  if (/generator|aggregat/.test(name)) return 'generator';
  return 'other';
}

export function convertTerminal(ctx: ImportContext, systems: Systems, id: number): OutEl | null {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const bp = boxPoint(mesh);
  const system = systems.systemOf(id, 'hvac');
  const level = ctx.levelOf(id, mesh.min.z);
  return ctx.add('terminal', id, level, {
    number: ctx.label(id), terminal_type: terminalType(ctx, id, system), system_type: system, family: ctx.label(ctx.model.typeOf.get(id) ?? 0) ?? ctx.label(id),
  }, { type: 'Point', coordinates: bp.coordinates }, pointProps(bp));
}

export function convertEquipment(ctx: ImportContext, systems: Systems, id: number): OutEl | null {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const bp = boxPoint(mesh);
  const level = ctx.levelOf(id, mesh.min.z);
  return ctx.add('equipment', id, level, {
    number: ctx.label(id), equipment_type: equipmentType(ctx, id), system_type: systems.systemOf(id, 'hvac'),
    family: ctx.label(ctx.model.typeOf.get(id) ?? 0) ?? ctx.label(id),
  }, { type: 'Point', coordinates: bp.coordinates }, pointProps(bp));
}

const ACCESSORY_CLASS: Record<string, string> = {
  IfcValve: 'valve', IfcDamper: 'damper', IfcFlowMeter: 'flow_meter', IfcFilter: 'strainer', IfcSensor: 'sensor',
};

/** Fitting (kind empty) or accessory (valve / damper / …) → mep_node at the body centre. */
export function convertNode(ctx: ImportContext, systems: Systems, id: number, accessory: boolean): OutEl | null {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const { model } = ctx;
  const ports = (model.ports.get(id) ?? []).map(p => portPosition(ctx, p)).filter((p): p is V3 => !!p);
  // A fitting sits where its ports meet: their mean (elbows), else the body centre
  const c: V3 = ports.length >= 2
    ? scale3(ports.reduce((s, p) => add3(s, p), { x: 0, y: 0, z: 0 }), 1 / ports.length)
    : { x: (mesh.min.x + mesh.max.x) / 2, y: (mesh.min.y + mesh.max.y) / 2, z: (mesh.min.z + mesh.max.z) / 2 };
  const t = model.typeOf.get(id);
  const tcls = t ? model.className(t).replace(/Type$/, '') : '';
  const cls = model.className(id);
  let kind: string | undefined;
  if (accessory) {
    kind = ACCESSORY_CLASS[cls] ?? ACCESSORY_CLASS[tcls];
    const name = (ctx.label(id) ?? '').toLowerCase();
    if (!kind) kind = /damper|klappe/.test(name) ? 'damper' : /check|rückschlag/.test(name) ? 'check_valve' : /valve|ventil|hahn|schieber/.test(name) ? 'valve' : 'other_accessory';
  }
  const level = ctx.levelOf(id, mesh.min.z);
  const size = Math.max(mesh.max.x - mesh.min.x, mesh.max.y - mesh.min.y, mesh.max.z - mesh.min.z);
  return ctx.add('mep_node', id, level, {
    number: ctx.label(id), kind, system_type: systems.systemOf(id, 'hvac'), family: accessory ? ctx.label(t ?? 0) ?? ctx.label(id) : undefined,
    size_w: accessory ? r3(size) : undefined,
  }, { type: 'Point', coordinates: [r3(c.x), r3(c.y), r3(c.z)] });
}

/**
 * Port connections → from / to on the curves (bare host ids of the node /
 * equipment / terminal at each end, nearest end first).
 */
export function linkSegments(ctx: ImportContext): number {
  const { model } = ctx;
  const SEG = new Set(['duct', 'pipe', 'cable_tray', 'conduit']);
  const POINTS = new Set(['mep_node', 'equipment', 'terminal']);
  let linked = 0;
  for (const el of ctx.out) {
    if (!SEG.has(el.table) || !el.src) continue;
    const coords = (el.geometry as { coordinates: number[][] }).coordinates;
    const ends = [coords[0], coords[coords.length - 1]];
    for (const port of model.ports.get(el.src) ?? []) {
      const other = model.portLink.get(port);
      const owner = other ? model.portOwner.get(other) : undefined;
      const target = owner ? (ctx.bySrc.get(owner) ?? []).find(o => POINTS.has(o.table)) : undefined;
      if (!target || target.level !== el.level) continue;
      const pos = portPosition(ctx, port);
      if (!pos) continue;
      const end = dist2({ x: pos.x, y: pos.y }, { x: ends[0][0], y: ends[0][1] }) + Math.abs(pos.z - ends[0][2])
        <= dist2({ x: pos.x, y: pos.y }, { x: ends[1][0], y: ends[1][1] }) + Math.abs(pos.z - ends[1][2]) ? 'from' : 'to';
      if (!el.attrs[end]) { el.attrs[end] = target.id; linked++; }
    }
  }
  return linked;
}
