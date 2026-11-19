/**
 * Inline equipment (VAV box, inline pump, inline fan, duct coil): placing
 * one on a duct / pipe splits the run, lines the device up with it (inlet
 * upstream, at the run height) and wires the halves to its inlet / outlet
 * ports. The pass-through ports take the run's system and size, so the
 * check sees no system or size mismatch.
 */
import type { CanonicalElement, LineElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import type { EquipmentStarter, StarterPort } from '../elements/equipment_starters.ts';
import { materializeStarter } from '../elements/equipment_starters.ts';
import { endZ, zAt } from '../model/mepSplit.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { isMepLineTable } from '../model/mepTopology.ts';
import { generateId } from '../model/ids.ts';

type MepCurve = LineElement | SpatialLineElement;

const TABLE_BY_DOMAIN: Record<string, string> = { hvac: 'duct', piping: 'pipe' };

/** The in / out port pair of a starter that can sit inline in a run, and that run's table. */
export function inlinePorts(starter: EquipmentStarter | null): { inlet: StarterPort; outlet: StarterPort; table: string } | null {
  if (!starter) return null;
  for (const domain of ['hvac', 'piping'] as const) {
    const ports = starter.ports.filter(p => p.domain === domain && Math.abs(p.dir[2]) < 0.3);
    const inlet = ports.find(p => p.flow_dir === 'in'), outlet = ports.find(p => p.flow_dir === 'out');
    if (!inlet || !outlet || ports.length !== 2) continue;
    // Opposite directions along the line through both ports, at one height.
    const ax = outlet.offset[0] - inlet.offset[0], ay = outlet.offset[1] - inlet.offset[1];
    const L = Math.hypot(ax, ay);
    if (L < 1e-3 || Math.abs(outlet.offset[2] - inlet.offset[2]) > 1e-3) continue;
    const along = (d: [number, number, number]) => (d[0] * ax + d[1] * ay) / L;
    if (along(outlet.dir) < 0.95 || along(inlet.dir) > -0.95) continue;
    return { inlet, outlet, table: TABLE_BY_DOMAIN[domain] };
  }
  return null;
}

/**
 * +1 when the run's flow goes start → end, -1 when a source (a device's
 * `out` port on the same system) is found beyond its end first.
 */
export function flowSense(curve: MepCurve, elements: ReadonlyMap<string, CanonicalElement>): 1 | -1 {
  const system = curve.attrs.system_type ?? '';
  const byHost = new Map<string, MepCurve[]>();
  for (const el of elements.values()) {
    if (!isMepLineTable(el.tableName) || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    for (const r of [el.attrs.from, el.attrs.to]) {
      const p = parsePortRef(r);
      if (!p) continue;
      const list = byHost.get(p.hostId) ?? [];
      list.push(el as MepCurve);
      byHost.set(p.hostId, list);
    }
  }
  const outPorts = new Set<string>();
  for (const el of elements.values()) {
    if (el.tableName !== 'connector' || (el.attrs.flow_dir ?? '') !== 'out') continue;
    const host = elements.get(el.hostId || el.attrs.host_id || '');
    if (host && host.tableName !== 'mep_node' && (!system || (el.attrs.system_type ?? '') === system)) outPorts.add(`${host.id}:${el.attrs.name}`);
  }
  // Breadth-first from one end; true when a source port is reached.
  const reachesSource = (ref: string | undefined): boolean => {
    const seen = new Set<string>([curve.id]);
    let frontier = [ref];
    for (let step = 0; step < 4000 && frontier.length; step++) {
      const next: (string | undefined)[] = [];
      for (const r of frontier) {
        if (outPorts.has(r ?? '')) return true;
        const p = parsePortRef(r);
        // Through fittings and accessories only (devices stop the search).
        if (!p || (p.portName && elements.get(p.hostId)?.tableName !== 'mep_node')) continue;
        for (const c of byHost.get(p.hostId) ?? []) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          for (const o of [c.attrs.from, c.attrs.to]) if (parsePortRef(o)?.hostId !== p.hostId) next.push(o);
        }
      }
      frontier = next;
    }
    return false;
  };
  if (reachesSource(curve.attrs.from)) return 1;
  return reachesSource(curve.attrs.to) ? -1 : 1;
}

/**
 * Elements inserting `starter` into `curve` at plan point `at`: the two run
 * halves, the device and its connectors. Null when it doesn't fit (vertical
 * run, too short, wrong table).
 */
export function insertInlineEquipment(
  curve: MepCurve,
  at: { x: number; y: number },
  starter: EquipmentStarter,
  levelId: string,
  ids: Set<string>,
  elements: ReadonlyMap<string, CanonicalElement>,
): CanonicalElement[] | null {
  const pair = inlinePorts(starter);
  if (!pair || pair.table !== curve.tableName) return null;
  const za = endZ(curve, 'start'), zb = endZ(curve, 'end');
  const dx = curve.end.x - curve.start.x, dy = curve.end.y - curve.start.y;
  const planLen = Math.hypot(dx, dy);
  if (planLen < 1e-3 || Math.abs(zb - za) > 0.02 * planLen + 1e-3) return null; // horizontal runs only
  const { inlet, outlet } = pair;
  const lx = outlet.offset[0] - inlet.offset[0], ly = outlet.offset[1] - inlet.offset[1];
  const L = Math.hypot(lx, ly);
  if (planLen < L + 0.1) return null;
  const sense = flowSense(curve, elements);
  const fx = (dx / planLen) * sense, fy = (dy / planLen) * sense;
  // Device centre along the run, kept clear of the ends.
  const t0 = ((at.x - curve.start.x) * dx + (at.y - curve.start.y) * dy) / (planLen * planLen);
  const half = L / 2 / planLen;
  const t = Math.max(half + 0.02, Math.min(1 - half - 0.02, t0));
  const c = { x: curve.start.x + dx * t, y: curve.start.y + dy * t };
  const zc = zAt(curve, c);
  const rotation = Math.atan2(fy, fx) - Math.atan2(ly, lx);
  const rotDeg = Math.round(((rotation * 180) / Math.PI) * 100) / 100;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const mx = (inlet.offset[0] + outlet.offset[0]) / 2, my = (inlet.offset[1] + outlet.offset[1]) / 2;
  const hostPos = { x: c.x - (mx * cos - my * sin), y: c.y - (mx * sin + my * cos) };
  const base = Math.round((zc - inlet.offset[2]) * 1e4) / 1e4;
  const made = materializeStarter(starter, hostPos, levelId, ids, rotDeg, String(base));
  // materializeStarter keeps a 0 base offset only when told so explicitly.
  const host = made[0] as PointElement;
  host.attrs.base_offset = String(base);
  const system = (curve.attrs.system_type ?? '').trim();
  const shape = curve.attrs.shape || (curve.tableName === 'duct' ? 'rect' : 'round');
  for (const el of made.slice(1)) {
    if (el.attrs.name !== inlet.name && el.attrs.name !== outlet.name) continue;
    if (system) el.attrs.system_type = system;
    el.attrs.shape = shape;
    el.attrs.size_w = curve.attrs.size_x ?? el.attrs.size_w;
    el.attrs.size_h = shape === 'round' ? '' : (curve.attrs.size_y ?? el.attrs.size_h);
  }
  if (system) {
    const others = new Set(made.slice(1).filter(e => e.attrs.name !== inlet.name && e.attrs.name !== outlet.name && (e.attrs.domain ?? '') !== 'electrical').map(e => e.attrs.system_type));
    host.attrs.system_type = [system, ...[...others].filter(s => s && s !== system)].join(',');
  }
  // Port positions on the run: inlet upstream.
  const pIn = { x: c.x - fx * L / 2, y: c.y - fy * L / 2 }, pOut = { x: c.x + fx * L / 2, y: c.y + fy * L / 2 };
  const nearStart = sense > 0 ? { p: pIn, ref: `${host.id}:${inlet.name}` } : { p: pOut, ref: `${host.id}:${outlet.name}` };
  const nearEnd = sense > 0 ? { p: pOut, ref: `${host.id}:${outlet.name}` } : { p: pIn, ref: `${host.id}:${inlet.name}` };
  const spatial = curve.geometry === 'spatial_line';
  const zA = zAt(curve, nearStart.p), zB = zAt(curve, nearEnd.p);
  const downId = generateId(curve.tableName, ids);
  ids.add(downId);
  const upstream = {
    ...curve, end: nearStart.p, ...(spatial ? { endZ: zA } : {}),
    attrs: { ...curve.attrs, to: nearStart.ref, ...(spatial ? { end_z: String(round(zA)) } : {}) },
  } as MepCurve;
  const downstream = {
    ...curve, id: downId, start: nearEnd.p, ...(spatial ? { startZ: zB } : {}),
    attrs: { ...curve.attrs, id: downId, number: '', from: nearEnd.ref, to: curve.attrs.to ?? '', ...(spatial ? { start_z: String(round(zB)) } : {}) },
  } as MepCurve;
  return [upstream, downstream, ...made];
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
