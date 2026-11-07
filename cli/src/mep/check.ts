/**
 * MEP connectivity check — pure core, no I/O.
 *
 * Two identical copies: bimdown-spec `cli/src/mep/check.ts` (bimdown build /
 * mep-check / resolve-topology) and bimdown-editor `editor/src/mep/mepCheck.ts`
 * (connectivity panel). Edit one, copy it over the other.
 *
 * Input is a flat, unit-agnostic model: curves (duct / pipe / conduit /
 * cable_tray) with 3D end points and `from` / `to` port refs, hosts
 * (equipment / terminal / mep_node) and their declared ports with world
 * positions. Output is a list of problems: open ends, references that don't
 * resolve, ends that don't sit on the port they reference, system and domain
 * mismatches, devices with no connection, orphan fittings, circuit problems.
 */

export type Vec3 = [number, number, number];

export interface MepCurveIn {
  id: string;
  /** Id scope (level directory). Ids are unique per level; refs resolve in
   *  the curve's own scope first, then `global`, then anywhere. */
  scope?: string;
  table: string;
  a: Vec3;
  b: Vec3;
  from: string;
  to: string;
  system: string;
  /** Section (model units); omitted = unknown (no size checks). */
  shape?: string;
  w?: number;
  h?: number;
}

export interface MepHostIn {
  id: string;
  scope?: string;
  table: 'equipment' | 'terminal' | 'mep_node';
  pos: Vec3;
  /** mep_node.kind (empty = passive fitting). */
  kind: string;
  /** mep_node.fitting hint (cap / open keep a single-curve node). */
  fitting: string;
  system: string;
  /** equipment / terminal circuit_id. */
  circuitId: string;
  load: number;
  /** Design flow (L/s), equipment / terminals. */
  flow?: number;
}

export interface MepPortIn {
  hostId: string;
  scope?: string;
  name: string;
  pos: Vec3;
  system: string;
  domain: string;
  shape?: string;
  w?: number;
  h?: number;
  /** in / out / bidirectional. */
  flowDir?: string;
}

export interface MepCircuitIn {
  id: string;
  scope?: string;
  hostId: string;
  number: string;
  voltage: number;
  rating: number;
}

export interface MepModelIn {
  curves: MepCurveIn[];
  hosts: MepHostIn[];
  ports: MepPortIn[];
  circuits?: MepCircuitIn[];
  /** When false, refs to hosts that aren't in the model are reported as
   *  `info` (the editor only sees one level at a time). Default true. */
  complete?: boolean;
  /** Incomplete models: refs (`host` or `host:port`) made by curves outside
   *  the model (other levels), so a riser's node or a port used from the
   *  floor above counts as connected. */
  externalRefs?: string[];
  /** Incomplete models: host ids that exist outside the model; a ref to a
   *  host found nowhere is a broken reference. */
  externalHosts?: string[];
}

export type MepProblemCode =
  | 'open_end' | 'dangling_ref' | 'port_far' | 'node_far' | 'self_loop'
  | 'system_mismatch' | 'domain_mismatch' | 'disconnected_device'
  | 'unconnected_port' | 'unused_port' | 'orphan_fitting'
  | 'no_circuit' | 'circuit_overload' | 'external_ref'
  | 'duplicate_segment' | 'size_mismatch' | 'flow_balance';

export interface MepProblem {
  severity: 'warning' | 'info';
  code: MepProblemCode;
  /** Element the problem is reported on. */
  id: string;
  scope?: string;
  table: string;
  message: string;
  /** Where to look (model units, same frame as the input). */
  at?: Vec3;
  system?: string;
  /** Message variant and values, for translated messages (`message` is English). */
  key?: string;
  vars?: Record<string, string | number>;
  /** The other element (duplicate segment). */
  other?: string;
}

/** A curve end must sit within this distance of the port it references. */
export const PORT_TOLERANCE = 0.05;
/** Revit puts curve ends at fitting faces, an arm away from the node centre. */
export const NODE_TOLERANCE = 2.0;

const DOMAIN_TABLES: Record<string, string[]> = {
  hvac: ['duct'],
  piping: ['pipe'],
  electrical: ['conduit', 'cable_tray'],
  cable_tray_conduit: ['conduit', 'cable_tray'],
};

const SINGLE_ENDED_FITTINGS = new Set(['cap', 'open']);

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function splitRef(ref: string): { hostId: string; port: string | null } | null {
  const s = (ref ?? '').trim();
  if (!s) return null;
  const i = s.indexOf(':');
  return i < 0 ? { hostId: s, port: null } : { hostId: s.slice(0, i), port: s.slice(i + 1) };
}

function fmtId(id: string): string { return id; }

export function checkMep(model: MepModelIn): MepProblem[] {
  const complete = model.complete ?? true;
  const extHosts = model.externalHosts ? new Set(model.externalHosts) : null;
  /** A ref to a host missing from the model: broken unless it may live elsewhere. */
  const missingIsBroken = (hostId: string) => complete || (extHosts !== null && !extHosts.has(hostId));
  const out: MepProblem[] = [];
  const key = (scope: string | undefined, id: string) => `${scope ?? ''}/${id}`;
  const hostByKey = new Map<string, MepHostIn>();
  const hostById = new Map<string, MepHostIn>();
  for (const h of model.hosts) {
    hostByKey.set(key(h.scope, h.id), h);
    if (!hostById.has(h.id)) hostById.set(h.id, h);
  }
  /** Resolve a host id the way refs do: own scope, then global, then any. */
  const findHost = (scope: string | undefined, id: string): MepHostIn | undefined =>
    hostByKey.get(key(scope, id)) ?? hostByKey.get(key('global', id)) ?? hostById.get(id);
  const hkey = (h: MepHostIn) => key(h.scope, h.id);
  const portsByHost = new Map<string, MepPortIn[]>();
  for (const p of model.ports) {
    const host = findHost(p.scope, p.hostId);
    if (!host) continue;
    const list = portsByHost.get(hkey(host)) ?? [];
    list.push(p);
    portsByHost.set(hkey(host), list);
  }
  const portsOf = (h: MepHostIn) => portsByHost.get(hkey(h)) ?? [];
  /** host key → set of referenced port names ('' = bare host ref). */
  const usedPorts = new Map<string, Set<string>>();
  /** passive node key → curves at it. */
  const nodeCurves = new Map<string, MepCurveIn[]>();
  /** Host ids / host:port refs used by curves outside the model. */
  const extUsed = new Set<string>();
  for (const r of model.externalRefs ?? []) {
    const p = splitRef(r);
    if (!p) continue;
    extUsed.add(p.hostId);
    if (p.port) extUsed.add(`${p.hostId}:${p.port}`);
  }

  for (const c of model.curves) {
    const refs = [{ side: 'from' as const, ref: c.from }, { side: 'to' as const, ref: c.to }];
    const parsed = refs.map(r => splitRef(r.ref));
    // Which end is `from`: the end nearer the from-host (Revit may reverse curves).
    let fromEnd = c.a, toEnd = c.b;
    const anchorOf = (r: { hostId: string; port: string | null } | null): Vec3 | null => {
      if (!r) return null;
      const host = findHost(c.scope, r.hostId);
      if (!host) return null;
      const port = r.port ? portsOf(host).find(p => p.name === r.port) : undefined;
      return port?.pos ?? host.pos;
    };
    const fromAnchor = anchorOf(parsed[0]);
    const toAnchor = anchorOf(parsed[1]);
    if (fromAnchor ? dist(fromAnchor, c.b) < dist(fromAnchor, c.a) : (toAnchor && dist(toAnchor, c.a) < dist(toAnchor, c.b))) {
      fromEnd = c.b; toEnd = c.a;
    }

    if (parsed[0] && parsed[1] && parsed[0].hostId === parsed[1].hostId && parsed[0].port === parsed[1].port) {
      out.push({ severity: 'warning', code: 'self_loop', id: c.id, scope: c.scope, table: c.table, system: c.system,
        message: `${c.table} ${fmtId(c.id)} starts and ends on the same ${parsed[0].port ? 'port' : 'fitting'} (${c.from})`, at: c.a,
        key: 'self_loop', vars: { table: c.table, id: c.id, ref: c.from } });
      continue;
    }

    for (let i = 0; i < 2; i++) {
      const side = refs[i].side;
      const end = i === 0 ? fromEnd : toEnd;
      const r = parsed[i];
      if (!r) {
        out.push({ severity: 'warning', code: 'open_end', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)} has an open end (${side} is empty)`, at: end,
          key: 'open_end', vars: { table: c.table, id: c.id, side } });
        continue;
      }
      const host = findHost(c.scope, r.hostId);
      if (!host) {
        const broken = missingIsBroken(r.hostId);
        out.push({ severity: broken ? 'warning' : 'info', code: broken ? 'dangling_ref' : 'external_ref', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)}.${side} = "${refs[i].ref}" references a missing element`, at: end,
          key: 'dangling_ref', vars: { table: c.table, id: c.id, side, ref: refs[i].ref } });
        continue;
      }
      const used = usedPorts.get(hkey(host)) ?? new Set<string>();
      used.add(r.port ?? '');
      usedPorts.set(hkey(host), used);

      if (!r.port) {
        if (host.table === 'mep_node' && !host.kind) {
          const list = nodeCurves.get(hkey(host)) ?? [];
          list.push(c);
          nodeCurves.set(hkey(host), list);
        }
        if (dist(end, host.pos) > NODE_TOLERANCE) {
          out.push({ severity: 'warning', code: 'node_far', id: c.id, scope: c.scope, table: c.table, system: c.system,
            message: `${c.table} ${fmtId(c.id)}.${side} references ${host.id} but ends ${dist(end, host.pos).toFixed(2)} away from it`, at: end,
            key: 'node_far', vars: { table: c.table, id: c.id, side, host: host.id, d: dist(end, host.pos).toFixed(2) } });
        }
        continue;
      }
      const port = portsOf(host).find(p => p.name === r.port);
      if (!port) {
        out.push({ severity: 'warning', code: 'dangling_ref', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)}.${side} = "${refs[i].ref}": ${host.id} has no port "${r.port}"`, at: end,
          key: 'dangling_port', vars: { table: c.table, id: c.id, side, ref: refs[i].ref, host: host.id, port: r.port } });
        continue;
      }
      const d = Math.min(dist(c.a, port.pos), dist(c.b, port.pos));
      if (d > PORT_TOLERANCE) {
        out.push({ severity: 'warning', code: 'port_far', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)}.${side} references ${refs[i].ref} but its nearest end is ${d.toFixed(3)} from the port — move the end onto the port`, at: port.pos,
          key: 'port_far', vars: { table: c.table, id: c.id, side, ref: refs[i].ref, d: d.toFixed(3) } });
      }
      const allowed = DOMAIN_TABLES[port.domain];
      if (allowed && !allowed.includes(c.table)) {
        out.push({ severity: 'warning', code: 'domain_mismatch', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)} connects to ${port.domain} port ${refs[i].ref}`, at: port.pos,
          key: 'domain_port', vars: { table: c.table, id: c.id, domain: port.domain, ref: refs[i].ref } });
      }
      if (port.system && c.system && port.system !== c.system) {
        out.push({ severity: 'warning', code: 'system_mismatch', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)} is ${c.system} but port ${refs[i].ref} is ${port.system}`, at: port.pos,
          key: 'system_port', vars: { table: c.table, id: c.id, system: c.system, ref: refs[i].ref, portSystem: port.system } });
      }
      if (port.domain !== 'electrical' && !sameSection(c, port)) {
        // Terminals usually take a neck / flex connection: advisory there.
        out.push({ severity: host.table === 'terminal' ? 'info' : 'warning', code: 'size_mismatch', id: c.id, scope: c.scope, table: c.table, system: c.system,
          message: `${c.table} ${fmtId(c.id)} is ${sizeText(c)} but port ${refs[i].ref} is ${sizeText(port)} (add a transition)`, at: port.pos,
          key: 'size_mismatch', vars: { table: c.table, id: c.id, size: sizeText(c), ref: refs[i].ref, portSize: sizeText(port) } });
      }
    }
  }

  // Passive fittings: orphans, single-curve nodes, mixed systems / tables.
  for (const h of model.hosts) {
    if (h.table !== 'mep_node') continue;
    if (h.kind) {
      // Inline accessory: every declared port must be on the run.
      const used = usedPorts.get(hkey(h)) ?? new Set<string>();
      for (const p of portsOf(h)) {
        if (!used.has(p.name) && !extUsed.has(`${h.id}:${p.name}`)) {
          out.push({ severity: 'warning', code: 'unconnected_port', id: h.id, scope: h.scope, table: h.table, system: h.system || p.system,
            message: `${h.kind} ${h.id}: port "${p.name}" is not connected`, at: p.pos,
            key: 'unconnected_port', vars: { kind: h.kind, id: h.id, port: p.name } });
        }
      }
      continue;
    }
    const curves = nodeCurves.get(hkey(h)) ?? [];
    if (extUsed.has(h.id)) continue; // continues on another level
    if (curves.length === 0) {
      out.push({ severity: 'warning', code: 'orphan_fitting', id: h.id, scope: h.scope, table: h.table, system: h.system,
        message: `fitting ${h.id} has no connected curves`, at: h.pos,
        key: 'orphan_fitting', vars: { id: h.id } });
      continue;
    }
    if (curves.length === 1 && !SINGLE_ENDED_FITTINGS.has(h.fitting)) {
      out.push({ severity: 'warning', code: 'open_end', id: curves[0].id, scope: curves[0].scope, table: curves[0].table, system: curves[0].system,
        message: `${curves[0].table} ${curves[0].id} ends at ${h.id} with nothing else connected (cap it or connect it)`, at: h.pos,
        key: 'open_end_node', vars: { table: curves[0].table, id: curves[0].id, node: h.id } });
    }
    const systems = new Set(curves.map(c => c.system).filter(Boolean));
    if (systems.size > 1 && !ventOnStack(systems)) {
      out.push({ severity: 'warning', code: 'system_mismatch', id: h.id, scope: h.scope, table: h.table, system: [...systems].join(','),
        message: `fitting ${h.id} joins different systems: ${[...systems].join(', ')}`, at: h.pos,
        key: 'system_node', vars: { id: h.id, systems: [...systems].join(', ') } });
    }
    const tables = new Set(curves.map(c => c.table));
    if (tables.size > 1) {
      out.push({ severity: 'warning', code: 'domain_mismatch', id: h.id, scope: h.scope, table: h.table, system: h.system,
        message: `fitting ${h.id} joins ${[...tables].join(' and ')}`, at: h.pos,
        key: 'domain_node', vars: { id: h.id, tables: [...tables].join(' / ') } });
    }
  }

  // Devices: no connection at all, or unused ports. Electrical ports are fed by
  // circuits, not curves.
  const circuitIds = new Set((model.circuits ?? []).map(c => c.id));
  for (const h of model.hosts) {
    if (h.table === 'mep_node') continue;
    const ports = portsOf(h);
    const used = new Set(usedPorts.get(hkey(h)) ?? []);
    for (const p of ports) if (extUsed.has(`${h.id}:${p.name}`)) used.add(p.name);
    if (extUsed.has(h.id)) used.add('');
    const isElectric = (p: MepPortIn) => p.domain === 'electrical' && !used.has(p.name);
    const fluid = ports.filter(p => !isElectric(p));
    const electric = ports.filter(isElectric);
    if (electric.length > 0 && !h.circuitId && fluid.length === 0 && (model.circuits?.length ?? 0) > 0) {
      out.push({ severity: 'info', code: 'no_circuit', id: h.id, scope: h.scope, table: h.table, system: h.system,
        message: `${h.table} ${h.id} is not on a circuit`, at: h.pos,
        key: 'no_circuit', vars: { table: h.table, id: h.id } });
    }
    if (h.circuitId && complete && !circuitIds.has(h.circuitId)) {
      out.push({ severity: 'warning', code: 'dangling_ref', id: h.id, scope: h.scope, table: h.table, system: h.system,
        message: `${h.table} ${h.id}.circuit_id = "${h.circuitId}" references a missing circuit`, at: h.pos,
        key: 'dangling_circuit', vars: { table: h.table, id: h.id, ref: h.circuitId } });
    }
    if (fluid.length === 0) continue;
    const connected = fluid.filter(p => used.has(p.name));
    if (connected.length === 0 && !used.has('')) {
      out.push({ severity: 'warning', code: 'disconnected_device', id: h.id, scope: h.scope, table: h.table, system: h.system,
        message: `${h.table} ${h.id} has ${fluid.length} port(s) and none is connected`, at: h.pos,
        key: 'disconnected_device', vars: { table: h.table, id: h.id, n: fluid.length } });
    } else {
      for (const p of fluid) {
        if (used.has(p.name)) continue;
        out.push({ severity: 'info', code: 'unused_port', id: h.id, scope: h.scope, table: h.table, system: p.system,
          message: `${h.table} ${h.id}: port "${p.name}" (${p.system || p.domain}) is not connected`, at: p.pos,
          key: 'unused_port', vars: { table: h.table, id: h.id, port: p.name, system: p.system || p.domain } });
      }
    }
  }

  // Circuits: missing panel, connected load over 80 % of the breaker.
  for (const c of model.circuits ?? []) {
    if (!findHost(c.scope, c.hostId)) {
      const broken = missingIsBroken(c.hostId);
      out.push({ severity: broken ? 'warning' : 'info', code: broken ? 'dangling_ref' : 'external_ref', id: c.id, scope: c.scope, table: 'circuit',
        message: `circuit ${c.id} panel "${c.hostId}" is missing`,
        key: 'dangling_panel', vars: { id: c.id, ref: c.hostId } });
    }
    if (c.voltage > 0 && c.rating > 0) {
      const load = model.hosts.filter(h => h.circuitId === c.id).reduce((s, h) => s + (h.load || 0), 0);
      const cap = c.voltage * c.rating * 0.8;
      if (load > cap) {
        out.push({ severity: 'warning', code: 'circuit_overload', id: c.id, scope: c.scope, table: 'circuit',
          message: `circuit ${c.number || c.id}: ${Math.round(load)} W exceeds 80 % of ${c.rating} A × ${c.voltage} V`,
          key: 'circuit_overload', vars: { id: c.number || c.id, load: Math.round(load), rating: c.rating, voltage: c.voltage } });
      }
    }
  }

  out.push(...duplicateSegments(model.curves));
  out.push(...flowBalance(model, findHost, hkey, portsOf));
  return out;
}

const VENT = /^(V|VENT|VTR|SV)$/i;
const DRAIN = /^(SAN|SS|SW|W|WASTE|SOIL|D|DR|DRAIN)$/i;
/** A plumbing vent tying into the one drainage system it ventilates. */
function ventOnStack(systems: Set<string>): boolean {
  const list = [...systems];
  return list.every(s => VENT.test(s) || DRAIN.test(s)) && list.filter(s => DRAIN.test(s)).length === 1;
}

const roundSection = (table: string, shape: string | undefined) => table === 'pipe' || table === 'conduit' || shape === 'round';
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-3, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

/** A curve section equals a port section (rect sides in either order). Unknown sizes match. */
export function sameSection(c: { table: string; shape?: string; w?: number; h?: number }, p: { shape?: string; w?: number; h?: number }): boolean {
  if (!(c.w! > 0) || !(p.w! > 0)) return true;
  const cr = roundSection(c.table, c.shape), pr = roundSection(c.table, p.shape) || !(p.h! > 0);
  if (cr !== pr) return false;
  if (cr) return close(c.w!, p.w!);
  const ch = c.h! > 0 ? c.h! : c.w!, ph = p.h!;
  return (close(c.w!, p.w!) && close(ch, ph)) || (close(c.w!, ph) && close(ch, p.w!));
}

function sizeText(x: { table?: string; shape?: string; w?: number; h?: number }): string {
  const f = (v: number) => String(Math.round(v * 1e4) / 1e4);
  if (!(x.w! > 0)) return '?';
  return roundSection(x.table ?? '', x.shape) || !(x.h! > 0) ? `Ø${f(x.w!)}` : `${f(x.w!)}×${f(x.h!)}`;
}

/** Tolerance (model units) for two segments to count as on top of each other. */
const OVERLAP_TOL = 0.01;

/**
 * Duplicate / overlapping segments: two curves of the same table lying on
 * the same line and sharing more than OVERLAP_TOL of their length (a run
 * drawn twice, a back-and-forth riser).
 */
export function duplicateSegments(curves: MepCurveIn[]): MepProblem[] {
  const out: MepProblem[] = [];
  const items = curves.map(c => ({ c, lo: Math.min(c.a[0], c.b[0]), hi: Math.max(c.a[0], c.b[0]), len: dist(c.a, c.b) }))
    .filter(i => i.len > OVERLAP_TOL)
    .sort((p, q) => p.lo - q.lo);
  const flagged = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    for (let j = i + 1; j < items.length && items[j].lo <= A.hi + OVERLAP_TOL; j++) {
      const B = items[j];
      if (A.c.table !== B.c.table || (A.c.scope ?? '') !== (B.c.scope ?? '')) continue;
      const u: Vec3 = [(A.c.b[0] - A.c.a[0]) / A.len, (A.c.b[1] - A.c.a[1]) / A.len, (A.c.b[2] - A.c.a[2]) / A.len];
      // B's ends must lie on A's line.
      const off = (p: Vec3) => {
        const v: Vec3 = [p[0] - A.c.a[0], p[1] - A.c.a[1], p[2] - A.c.a[2]];
        const t = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
        return { t, d: Math.hypot(v[0] - u[0] * t, v[1] - u[1] * t, v[2] - u[2] * t) };
      };
      const p1 = off(B.c.a), p2 = off(B.c.b);
      if (p1.d > OVERLAP_TOL || p2.d > OVERLAP_TOL) continue;
      const overlap = Math.min(A.len, Math.max(p1.t, p2.t)) - Math.max(0, Math.min(p1.t, p2.t));
      if (overlap <= OVERLAP_TOL) continue;
      const key = `${B.c.scope ?? ''}/${B.c.id}`;
      if (flagged.has(key)) continue;
      flagged.add(key);
      const mid = Math.max(0, Math.min(p1.t, p2.t)) + overlap / 2;
      out.push({ severity: 'warning', code: 'duplicate_segment', id: B.c.id, scope: B.c.scope, table: B.c.table, system: B.c.system, other: A.c.id,
        message: `${B.c.table} ${B.c.id} lies on top of ${A.c.id} over ${overlap.toFixed(2)} (duplicate segment, delete one)`,
        at: [A.c.a[0] + u[0] * mid, A.c.a[1] + u[1] * mid, A.c.a[2] + u[2] * mid],
        key: 'duplicate_segment', vars: { table: B.c.table, id: B.c.id, other: A.c.id, length: overlap.toFixed(2) } });
    }
  }
  return out;
}

/**
 * Supply flow balance: equipment with a design flow vs the sum of the air
 * terminals its supply port reaches (through fittings, accessories and
 * pass-through devices such as VAV boxes). More than 10 % apart is flagged.
 */
function flowBalance(
  model: MepModelIn,
  findHost: (scope: string | undefined, id: string) => MepHostIn | undefined,
  hkey: (h: MepHostIn) => string,
  portsOf: (h: MepHostIn) => MepPortIn[],
): MepProblem[] {
  const out: MepProblem[] = [];
  const at = new Map<string, MepCurveIn[]>();
  const ends = new Map<MepCurveIn, MepHostIn[]>();
  for (const c of model.curves) {
    const hs: MepHostIn[] = [];
    for (const ref of [c.from, c.to]) {
      const r = splitRef(ref);
      const h = r ? findHost(c.scope, r.hostId) : undefined;
      if (!h) continue;
      hs.push(h);
      const list = at.get(hkey(h)) ?? [];
      list.push(c);
      at.set(hkey(h), list);
    }
    ends.set(c, hs);
  }
  const passThrough = (h: MepHostIn) => {
    const fl = portsOf(h).filter(p => p.domain === 'hvac');
    return fl.length === 2 && fl.map(p => p.flowDir ?? '').sort().join(',') === 'in,out';
  };
  for (const h of model.hosts) {
    if (h.table !== 'equipment' || !(h.flow! > 0)) continue;
    for (const p of portsOf(h)) {
      if (p.domain !== 'hvac' || p.flowDir !== 'out') continue;
      const start = (at.get(hkey(h)) ?? []).filter(c => [c.from, c.to].some(r => splitRef(r)?.port === p.name));
      if (start.length === 0) continue;
      const seenC = new Set<MepCurveIn>(), seenH = new Set<string>([hkey(h)]);
      const queue = [...start];
      let sum = 0, n = 0;
      while (queue.length) {
        const c = queue.pop()!;
        if (seenC.has(c)) continue;
        seenC.add(c);
        for (const o of ends.get(c) ?? []) {
          const k = hkey(o);
          if (seenH.has(k)) continue;
          seenH.add(k);
          if (o.table === 'terminal') { sum += o.flow ?? 0; n++; continue; }
          if (o.table === 'mep_node' || passThrough(o)) queue.push(...(at.get(k) ?? []));
        }
      }
      if (n === 0 || !(sum > 0) || Math.abs(sum - h.flow!) <= 0.1 * h.flow!) continue;
      const f = (v: number) => String(Math.round(v * 10) / 10);
      out.push({ severity: 'warning', code: 'flow_balance', id: h.id, scope: h.scope, table: h.table, system: p.system || h.system,
        message: `equipment ${h.id} supplies ${f(h.flow!)} L/s from port "${p.name}" but its ${n} terminal(s) take ${f(sum)} L/s`, at: p.pos,
        key: 'flow_balance', vars: { id: h.id, flow: f(h.flow!), port: p.name, n, sum: f(sum) } });
    }
  }
  return out;
}
