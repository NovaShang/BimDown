/**
 * MEP topology: `from` / `to` on every duct / pipe / conduit / cable tray end
 * from the IFC port graph (IfcDistributionPort nested in IFC4 or attached by
 * IfcRelConnectsPortToElement in IFC2x3, joined by IfcRelConnectsPorts), and
 * from geometry for elements that have no ports (curve ends on fitting and
 * device bodies, on each other, on another run's side).
 *
 * BimDown's graph is curves between hosts, so connections the port graph
 * makes directly are rebuilt in that shape:
 *  - run end ↔ run end: a coupling node where they meet;
 *  - run end ↔ another run's side (Revit taps, ports 3…n of a duct): the main
 *    is split there and a `tap` node joins the pieces and the branch;
 *  - host ↔ host (terminal on an elbow, fitting on fitting, damper on a tee):
 *    a short connector run between them.
 * Passive fittings then sit on the intersection of their legs' axes (where
 * the editor draws the elbow / tee) and get their kind (`fitting`) from the
 * IFC PredefinedType, the Revit family / type name, or legs and geometry.
 * Port placements are optional (Solibri-optimised files drop them); the port
 * flow direction (SINK = inlet) decides which end is `from`.
 */
import type { ImportContext, OutEl } from './context.js';
import type { Systems } from './mep-systems.js';
import { enumValue, str } from './model.js';
import { type V3, add3, apply, dot3, len3, norm3, r3, scale3, sub3 } from './math.js';
import { fittingKind, type Leg } from './mep-fittings.js';

const CURVES = new Set(['duct', 'pipe', 'cable_tray', 'conduit']);
const HOSTS = new Set(['mep_node', 'equipment', 'terminal']);

export interface MepTopologyReport {
  /** IfcDistributionPorts on imported MEP elements. */
  sourcePorts: number;
  /** IfcRelConnectsPorts between two imported MEP elements. */
  sourceLinks: number;
  /** Of those, links that became connections. */
  linksUsed: number;
  /** Connections found from geometry (elements without ports). */
  inferred: number;
  /** Run ends (after splits and connector runs) / with a host / open. */
  curveEnds: number;
  connectedEnds: number;
  openEnds: number;
  /** Open run ends whose source port has no connection either (true open ends). */
  sourceOpenEnds: number;
  couplings: number;
  taps: number;
  connectors: number;
  /** Passive fittings per recorded kind. */
  fittingKinds: Record<string, number>;
  /** Equipment connectors waiting for their names (internal; see nameEquipmentPorts). */
  pendingPorts?: PendingPort[];
}

interface Curve {
  el: OutEl;
  a: V3;
  b: V3;
  size: number;
  ports: number[];
  /** Flow from the port directions: +1 a→b, −1 b→a, 0 unknown. */
  flow: number;
  ends: [Host | null, Host | null];
  taps: { t: number; host: Host }[];
}

export interface Host {
  el: OutEl;
  min: V3;
  max: V3;
  ports: number[];
  /** Passive fitting (mep_node without kind). */
  passive: boolean;
  /** Node added by the importer; no IFC body. */
  added?: 'coupling' | 'tap';
}

interface Piece { el: OutEl; a: V3; b: V3; aHost: Host | null; bHost: Host | null; flow: number }

type Slot =
  | { k: 'end'; c: Curve; end: 0 | 1 }
  | { k: 'body'; c: Curve; t: number }
  | { k: 'host'; h: Host };

const v3 = (c: number[]): V3 => ({ x: c[0], y: c[1], z: c[2] ?? 0 });
const mid = (h: Host): V3 => scale3(add3(h.min, h.max), 0.5);
const pt = (p: V3): number[] => [r3(p.x), r3(p.y), r3(p.z)];

function clampBox(p: V3, h: Host): V3 {
  return { x: Math.min(Math.max(p.x, h.min.x), h.max.x), y: Math.min(Math.max(p.y, h.min.y), h.max.y), z: Math.min(Math.max(p.z, h.min.z), h.max.z) };
}
const boxDist = (p: V3, h: Host) => len3(sub3(p, clampBox(p, h)));

function project(p: V3, a: V3, b: V3): { t: number; d: number } {
  const ab = sub3(b, a);
  const L2 = dot3(ab, ab) || 1e-12;
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / L2));
  return { t, d: len3(sub3(p, add3(a, scale3(ab, t)))) };
}

const curveLen = (c: Curve) => len3(sub3(c.b, c.a));
const endOf = (c: Curve, e: 0 | 1) => (e === 0 ? c.a : c.b);
/** How far a port / body may sit from a run end and still be that end. */
const endTol = (c: Curve) => Math.max(0.1, 0.6 * c.size);

export function sectionSize(el: OutEl): number {
  const x = Number(el.attrs.size_x) || 0.1, y = Number(el.attrs.size_y) || x;
  return Math.max(x, y);
}

export function buildMepTopology(ctx: ImportContext, systems: Systems): MepTopologyReport {
  const { model } = ctx;
  const report: MepTopologyReport = {
    sourcePorts: 0, sourceLinks: 0, linksUsed: 0, inferred: 0, curveEnds: 0, connectedEnds: 0, openEnds: 0, sourceOpenEnds: 0,
    couplings: 0, taps: 0, connectors: 0, fittingKinds: {},
  };
  const curves: Curve[] = [];
  const hosts: Host[] = [];
  const bySrc = new Map<number, Curve | Host>();
  for (const el of ctx.out) {
    if (!el.src || !el.geometry) continue;
    if (CURVES.has(el.table) && el.geometry.type === 'LineString') {
      const cs = el.geometry.coordinates as number[][];
      const c: Curve = { el, a: v3(cs[0]), b: v3(cs[cs.length - 1]), size: sectionSize(el), ports: model.ports.get(el.src) ?? [], flow: 0, ends: [null, null], taps: [] };
      curves.push(c);
      if (!bySrc.has(el.src)) bySrc.set(el.src, c);
    } else if (HOSTS.has(el.table) && el.geometry.type === 'Point') {
      const mesh = ctx.mesh(el.src);
      const p = v3(el.geometry.coordinates as number[]);
      const h: Host = {
        el, min: mesh ? mesh.min : p, max: mesh ? mesh.max : p, ports: model.ports.get(el.src) ?? [],
        passive: el.table === 'mep_node' && !el.attrs.kind,
      };
      hosts.push(h);
      if (!bySrc.has(el.src)) bySrc.set(el.src, h);
    }
  }
  if (curves.length === 0 && hosts.length === 0) return report;
  for (const x of [...curves, ...hosts]) report.sourcePorts += x.ports.length;

  const links: [Slot, Slot][] = [];
  const portPos = (p: number): V3 | null => {
    const m = model.productMatrix(p);
    return m ? apply(m, 0, 0, 0) : null;
  };

  // ─── Port graph ──────────────────────────────────────────────────────────
  // Each link side on a run is placed by an anchor (the port position, the
  // host body, or where the two runs meet), jointly per run: each end takes
  // the nearest anchor, the rest sit on the run's side (taps).
  const seen = new Set<number>();
  const linkedPorts = new Set<number>();
  const raw: { x: Curve | Host; y: Curve | Host; p: number; q: number }[] = [];
  for (const x of [...curves, ...hosts]) {
    for (const p of x.ports) {
      const q = model.portLink.get(p);
      if (q === undefined) continue;
      linkedPorts.add(p);
      if (seen.has(p)) continue;
      seen.add(p); seen.add(q);
      const ownerQ = model.portOwner.get(q);
      const y = ownerQ !== undefined ? bySrc.get(ownerQ) : undefined;
      if (!y || y === x) continue;
      report.sourceLinks++;
      raw.push({ x, y, p, q });
    }
  }
  const sides: (Slot | null)[][] = raw.map(() => [null, null]);
  const pending = new Map<Curve, { li: number; side: 0 | 1; anchor: Anchor; port: number }[]>();
  raw.forEach((r, li) => {
    const pp = portPos(r.p), pq = portPos(r.q);
    const meet = isCurve(r.x) && isCurve(r.y) && !pp && !pq ? meetingPoint(r.x, r.y) : null;
    const both: [Curve | Host, Curve | Host, V3 | null, V3 | null, number][] = [[r.x, r.y, pp, pq, r.p], [r.y, r.x, pq, pp, r.q]];
    both.forEach(([o, other, own, theirs, port], side) => {
      if (!isCurve(o)) { sides[li][side] = { k: 'host', h: o }; return; }
      const anchor: Anchor = own ? { p: own } : theirs ? { p: theirs } : meet ? { p: meet } : { box: other as Host };
      const l = pending.get(o) ?? [];
      l.push({ li, side: side as 0 | 1, anchor, port });
      pending.set(o, l);
    });
  });
  for (const [c, list] of pending) {
    const slots = placeOnCurve(c, list.map(x => x.anchor));
    list.forEach((x, i) => {
      const s = slots[i];
      sides[x.li][x.side] = s;
      // Flow along runs: their SINK port is the inlet
      if (s.k === 'end' && !c.flow) {
        const f = enumValue(model.line(x.port)?.FlowDirection) ?? '';
        c.flow = f === 'SINK' ? (s.end === 0 ? 1 : -1) : f === 'SOURCE' ? (s.end === 0 ? -1 : 1) : 0;
      }
    });
  }
  sides.forEach(([a, b], li) => {
    // Host to host (a connector run follows): upstream first when the ports say so
    const sink = enumValue(model.line(raw[li].p)?.FlowDirection) === 'SINK';
    links.push(a!.k === 'host' && b!.k === 'host' && sink ? [b!, a!] : [a!, b!]);
    report.linksUsed++;
  });

  // ─── Geometry, for elements without ports ────────────────────────────────
  report.inferred = inferLinks(ctx, curves, hosts, systems, links);

  // ─── Body taps → split points with a tap node ────────────────────────────
  const tapHost = (c: Curve, t: number): Host => {
    const L = curveLen(c);
    const near = c.taps.find(x => Math.abs(x.t - t) * L < 0.05);
    if (near) return near.host;
    const at = add3(c.a, scale3(sub3(c.b, c.a), t));
    const el = ctx.add('mep_node', 0, c.el.level, {}, { type: 'Point', coordinates: pt(at) as [number, number, number] });
    systems.inherit(el, c.el);
    const h: Host = { el, min: at, max: at, ports: [], passive: true, added: 'tap' };
    hosts.push(h);
    c.taps.push({ t, host: h });
    report.taps++;
    return h;
  };
  const settle = (s: Slot): Slot => {
    if (s.k !== 'body') return s;
    const L = curveLen(s.c);
    if (s.t * L < 0.02) return { k: 'end', c: s.c, end: 0 };
    if ((1 - s.t) * L < 0.02) return { k: 'end', c: s.c, end: 1 };
    return { k: 'host', h: tapHost(s.c, s.t) };
  };
  // A fitting on a run's side (Revit takeoff / tap on the main): the main is split at the fitting itself
  const onSide = (body: Slot, other: Slot): boolean => {
    if (body.k !== 'body' || other.k !== 'host' || !other.h.passive || other.h.added) return false;
    const L = curveLen(body.c);
    if (body.t * L < 0.02 || (1 - body.t) * L < 0.02) return false;
    if (body.c.taps.some(x => x.host === other.h)) return true;
    if (body.c.taps.some(x => Math.abs(x.t - body.t) * L < 0.05)) return false;
    body.c.taps.push({ t: body.t, host: other.h });
    return true;
  };
  const pairs = links.filter(([a, b]) => !onSide(a, b) && !onSide(b, a)).map(([a, b]) => [settle(a), settle(b)] as [Slot, Slot]);

  // ─── Groups: run ends meeting at one host (or at each other) ─────────────
  const curveIx = new Map(curves.map((c, i) => [c, i]));
  const hostIx = new Map<Host, number>();
  const hix = (h: Host) => { let i = hostIx.get(h); if (i === undefined) hostIx.set(h, i = hostIx.size); return i; };
  const key = (s: Slot) => (s.k === 'end' ? `e${curveIx.get(s.c)}:${s.end}` : s.k === 'host' ? `h${hix(s.h)}` : '');
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let x = k; parent.get(x) !== r;) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  // Run ends joined to each other merge (a coupling where they meet); a host
  // is not a merge point (an AHU's ducts and pipes stay apart).
  const slotOf = new Map<string, Extract<Slot, { k: 'end' }>>();
  const hostsAt = new Map<string, Host[]>();
  const stubs: [Host, Host][] = [];
  const mark = (s: Extract<Slot, { k: 'end' }>) => {
    const k = key(s);
    if (!parent.has(k)) { parent.set(k, k); slotOf.set(k, s); }
    return k;
  };
  for (const [a, b] of pairs) {
    if (a.k === 'host' && b.k === 'host') { if (a.h !== b.h) stubs.push([a.h, b.h]); continue; }
    if (a.k === 'end' && b.k === 'end') {
      const ra = find(mark(a)), rb = find(mark(b));
      if (ra !== rb) parent.set(ra, rb);
      continue;
    }
    const [e, h] = a.k === 'end' ? [a, b as Extract<Slot, { k: 'host' }>] : [b as Extract<Slot, { k: 'end' }>, a as Extract<Slot, { k: 'host' }>];
    const k = mark(e);
    const l = hostsAt.get(k) ?? [];
    if (!l.includes(h.h)) l.push(h.h);
    hostsAt.set(k, l);
  }
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) {
    const r = find(k);
    const l = groups.get(r) ?? [];
    l.push(k);
    groups.set(r, l);
  }
  const rank = (h: Host) => (h.passive && !h.added ? 0 : h.added === 'tap' ? 1 : h.el.table === 'mep_node' ? 2 : h.el.table === 'terminal' ? 3 : 4);
  for (const keys of groups.values()) {
    const ends = keys.map(k => slotOf.get(k)!);
    const hs = [...new Set(keys.flatMap(k => hostsAt.get(k) ?? []))].sort((x, y) => rank(x) - rank(y));
    let hub = hs[0];
    if (!hub) {
      if (ends.length < 2) continue;
      // Runs joined end to end: a coupling where they meet
      const ps = ends.map(e => endOf(e.c, e.end));
      const at = scale3(ps.reduce((s, p) => add3(s, p), { x: 0, y: 0, z: 0 }), 1 / ps.length);
      const el = ctx.add('mep_node', 0, ends[0].c.el.level, {}, { type: 'Point', coordinates: pt(at) as [number, number, number] });
      systems.inherit(el, ends[0].c.el);
      hub = { el, min: at, max: at, ports: [], passive: true, added: 'coupling' };
      hosts.push(hub);
      report.couplings++;
    }
    for (const e of ends) if (!e.c.ends[e.end]) e.c.ends[e.end] = hub;
    // One end on two hosts (a fitting and the terminal it feeds): join the hosts
    for (const h of hs.slice(1)) stubs.push([hub, h]);
  }

  // ─── Split mains at their taps ───────────────────────────────────────────
  const pieces: Piece[] = [];
  for (const c of curves) {
    const ts = c.taps.slice().sort((x, y) => x.t - y.t);
    const pts: { p: V3; h: Host | null }[] = [{ p: c.a, h: c.ends[0] }];
    for (const x of ts) pts.push({ p: add3(c.a, scale3(sub3(c.b, c.a), x.t)), h: x.host });
    pts.push({ p: c.b, h: c.ends[1] });
    for (let i = 0; i + 1 < pts.length; i++) {
      const el = i === 0 ? c.el : ctx.add(c.el.table, c.el.src, c.el.level, { ...c.el.attrs }, null, { ...c.el.props });
      if (i > 0) systems.copy(c.el, el);
      const [p, q] = [pts[i], pts[i + 1]];
      el.geometry = { type: 'LineString', coordinates: [pt(p.p) as [number, number, number], pt(q.p) as [number, number, number]] };
      pieces.push({ el, a: p.p, b: q.p, aHost: p.h, bHost: q.h, flow: c.flow });
    }
  }

  const legsOf = new Map<Host, { piece: Piece; end: 0 | 1 }[]>();
  const addLeg = (h: Host | null, piece: Piece, end: 0 | 1) => {
    if (!h) return;
    const l = legsOf.get(h) ?? [];
    l.push({ piece, end });
    legsOf.set(h, l);
  };
  for (const pc of pieces) { addLeg(pc.aHost, pc, 0); addLeg(pc.bHost, pc, 1); }

  // Passive fittings on their legs' axes, accessories on their run
  for (const h of hosts) {
    if (h.el.table !== 'mep_node' || h.added === 'tap') continue;
    const legs = (legsOf.get(h) ?? []).map(l => legLine(l.piece, l.end));
    const p = h.passive ? fittingCenter(h, legs)
      : legs.length === 2 && dot3(legs[0].dir, legs[1].dir) < -0.985 ? scale3(add3(legs[0].p, legs[1].p), 0.5) : null;
    if (p) moveHost(h, p);
  }

  // ─── Connector runs between hosts that touch directly ────────────────────
  const done = new Set<string>();
  for (const [x, y] of stubs) {
    const k = [hix(x), hix(y)].sort((m, n) => m - n).join('-');
    if (done.has(k)) continue;
    done.add(k);
    const px = attachPoint(x, y), py = attachPoint(y, x);
    if (len3(sub3(px, py)) < 0.01) continue;
    // Size and table of the fitting side's runs (a device may mix ducts and pipes)
    const legRuns = (h: Host) => (legsOf.get(h) ?? []).map(l => l.piece.el).sort((a, b) => sectionSize(a) - sectionSize(b));
    const ref = (x.el.table === 'mep_node' ? legRuns(x)[0] : undefined) ?? (y.el.table === 'mep_node' ? legRuns(y)[0] : undefined)
      ?? legRuns(x)[0] ?? legRuns(y)[0];
    const airy = [x, y].some(h => /air|grille|diffuser/.test(String(h.el.attrs.terminal_type ?? '')));
    const table = ref?.table ?? (airy ? 'duct' : 'pipe');
    const attrs: Record<string, string | number | undefined> = ref
      ? { shape: ref.attrs.shape as string, size_x: ref.attrs.size_x as number, size_y: ref.attrs.size_y as number }
      : { shape: 'round', size_x: 0.1 };
    const el = ctx.add(table, 0, x.el.level, attrs, { type: 'LineString', coordinates: [pt(px) as [number, number, number], pt(py) as [number, number, number]] });
    if (!(ref && systems.inherit(el, ref))) systems.inherit(el, x.el.table === 'mep_node' ? x.el : y.el);
    const pc: Piece = { el, a: px, b: py, aHost: x, bHost: y, flow: 0 };
    pieces.push(pc);
    addLeg(x, pc, 0);
    addLeg(y, pc, 1);
    report.connectors++;
  }

  // ─── Refs (upstream end = from), systems along the graph, fitting kinds ──
  for (const pc of pieces) {
    const [from, to] = pc.flow < 0 ? [pc.bHost, pc.aHost] : [pc.aHost, pc.bHost];
    pc.el.attrs.from = from?.el.id;
    pc.el.attrs.to = to?.el.id;
    for (const h of [from, to]) {
      report.curveEnds++;
      if (h) report.connectedEnds++;
    }
  }
  report.openEnds = report.curveEnds - report.connectedEnds;
  for (const c of curves) {
    if (c.ports.length === 0) continue;
    const unlinked = c.ports.filter(p => !linkedPorts.has(p)).length;
    report.sourceOpenEnds += Math.min(unlinked, (c.ends[0] ? 0 : 1) + (c.ends[1] ? 0 : 1));
  }
  propagateSystems(systems, legsOf);
  for (const h of hosts) {
    if (!h.passive) continue;
    const legs: Leg[] = (legsOf.get(h) ?? []).map(l => ({ ...legLine(l.piece, l.end), el: l.piece.el }));
    const kind = fittingKind(ctx, h.el, h.added, h.ports.length, legs);
    if (kind) {
      h.el.attrs.fitting = kind;
      report.fittingKinds[kind] = (report.fittingKinds[kind] ?? 0) + 1;
    }
  }
  // Equipment ports: connector rows where its runs end (an AHU's ducts and
  // pipes reach its faces, far from the point), named once systems are known
  const ports: PendingPort[] = [];
  for (const h of hosts) {
    if (h.el.table !== 'equipment') continue;
    const hp = v3((h.el.geometry as { coordinates: number[] }).coordinates);
    const rot = (Number(h.el.props.rotation) || 0) * Math.PI / 180;
    const local = (v: V3): V3 => ({ x: v.x * Math.cos(rot) + v.y * Math.sin(rot), y: -v.x * Math.sin(rot) + v.y * Math.cos(rot), z: v.z });
    for (const l of legsOf.get(h) ?? []) {
      const { p, dir } = legLine(l.piece, l.end);
      const run = l.piece.el;
      const side = run.attrs.from === h.el.id && (run.attrs.to !== h.el.id || l.end === (l.piece.flow < 0 ? 1 : 0)) ? 'from' : 'to';
      const o = local(sub3(p, hp)), d = local(dir);
      const round = run.attrs.shape === 'round';
      const conn = ctx.add('connector', 0, h.el.level, {
        host_id: h.el.id, name: '', offset_x: r3(o.x), offset_y: r3(o.y), offset_z: r3(o.z), dir_x: r3(d.x), dir_y: r3(d.y), dir_z: r3(d.z),
        shape: round ? 'round' : 'rect', size_w: run.attrs.size_x, size_h: round ? undefined : run.attrs.size_y,
        flow_dir: l.piece.flow ? (side === 'from' ? 'out' : 'in') : undefined, domain: DOMAIN[run.table],
      }, null);
      ports.push({ conn, host: h.el, run, side });
    }
  }
  report.pendingPorts = ports;
  return report;
}

const DOMAIN: Record<string, string> = { duct: 'hvac', pipe: 'piping', conduit: 'cable_tray_conduit', cable_tray: 'cable_tray_conduit' };

interface PendingPort { conn: OutEl; host: OutEl; run: OutEl; side: 'from' | 'to' }

/**
 * After the systems are tagged: name each equipment connector by its run's
 * system ("sa", "hwr", "sa_2" …, else c0, c1) and point the run at it.
 */
export function nameEquipmentPorts(report: MepTopologyReport): void {
  const used = new Map<OutEl, Set<string>>();
  for (const pp of report.pendingPorts ?? []) {
    const names = used.get(pp.host) ?? new Set<string>();
    used.set(pp.host, names);
    const sys = String(pp.run.attrs.system_type ?? '').trim();
    const base = sys ? sys.replace(/-\d+'*$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_') : 'c';
    let name = base === 'c' ? `c${names.size}` : base;
    for (let i = 2; names.has(name); i++) name = base === 'c' ? `c${names.size + i}` : `${base}_${i}`;
    names.add(name);
    pp.conn.attrs.name = name;
    pp.conn.attrs.system_type = sys || undefined;
    pp.run.attrs[pp.side] = `${pp.host.id}:${name}`;
  }
  delete report.pendingPorts;
}

// ─── Link resolution ─────────────────────────────────────────────────────────

type Anchor = { p: V3; box?: undefined } | { box: Host; p?: undefined };

const isCurve = (o: Curve | Host): o is Curve => 'ends' in o;

/** Distance of a run end to an anchor (host bodies: inside = 0, the body centre breaks ties). */
function anchorCost(e: V3, a: Anchor): number {
  if (a.p) return len3(sub3(e, a.p));
  return boxDist(e, a.box!) + 1e-3 * len3(sub3(e, mid(a.box!)));
}

/**
 * Slots for the links of one run. A run's first two ports are its ends and
 * the rest are taps on its side (Revit), so at least `linked − (ports − 2)`
 * links must take an end; the best assignment of distinct anchors to the two
 * ends wins (an end left free costs the reach), anchors at the same spot as an
 * end's join it, and the others sit on the side where they project.
 */
function placeOnCurve(c: Curve, anchors: Anchor[]): Slot[] {
  const tol = endTol(c);
  const cost = anchors.map(a => [anchorCost(c.a, a), anchorCost(c.b, a)]);
  const n = anchors.length;
  const forced = Math.min(2, Math.max(0, n - Math.max(0, c.ports.length - 2)));
  let best = { s: Infinity, i: -1, j: -1 };
  for (let i = -1; i < n; i++) for (let j = -1; j < n; j++) {
    if (i >= 0 && i === j) continue;
    const taken = [i >= 0 ? cost[i][0] : null, j >= 0 ? cost[j][1] : null].filter((x): x is number => x !== null);
    const within = taken.filter(x => x <= tol).length;
    if (taken.length < forced || taken.length - within > Math.max(0, forced - within)) continue;
    const s = taken.reduce((a, b) => a + b, 0) + tol * (2 - taken.length);
    if (s < best.s - 1e-9) best = { s, i, j };
  }
  return anchors.map((a, k): Slot => {
    if (k === best.i) return { k: 'end', c, end: 0 };
    if (k === best.j) return { k: 'end', c, end: 1 };
    // Same spot as an end's anchor (several runs meeting there)
    for (const e of [0, 1] as const) {
      const ref = e === 0 ? best.i : best.j;
      if (ref >= 0 && cost[k][e] <= cost[ref][e] + 0.02) return { k: 'end', c, end: e };
    }
    const at = a.p ?? mid(a.box!);
    return { k: 'body', c, t: project(at, c.a, c.b).t };
  });
}

/** Where two port-less linked runs meet: the end of one nearest the other's axis. */
function meetingPoint(x: Curve, y: Curve): V3 {
  let best = { d: Infinity, p: x.a };
  for (const [o, m] of [[x, y], [y, x]] as const) {
    for (const e of [o.a, o.b]) {
      const d = project(e, m.a, m.b).d;
      if (d < best.d) best = { d, p: e };
    }
  }
  return best.p;
}

// ─── Geometric connections (no ports) ────────────────────────────────────────

const CELL = 1.0;

class Grid<T> {
  private cells = new Map<string, T[]>();
  insert(min: V3, max: V3, v: T): void {
    for (let i = Math.floor(min.x / CELL); i <= Math.floor(max.x / CELL); i++)
      for (let j = Math.floor(min.y / CELL); j <= Math.floor(max.y / CELL); j++)
        for (let k = Math.floor(min.z / CELL); k <= Math.floor(max.z / CELL); k++) {
          const key = `${i},${j},${k}`;
          const l = this.cells.get(key);
          if (l) { if (l[l.length - 1] !== v) l.push(v); } else this.cells.set(key, [v]);
        }
  }
  near(p: V3, r: number): Set<T> {
    const out = new Set<T>();
    for (let i = Math.floor((p.x - r) / CELL); i <= Math.floor((p.x + r) / CELL); i++)
      for (let j = Math.floor((p.y - r) / CELL); j <= Math.floor((p.y + r) / CELL); j++)
        for (let k = Math.floor((p.z - r) / CELL); k <= Math.floor((p.z + r) / CELL); k++)
          for (const v of this.cells.get(`${i},${j},${k}`) ?? []) out.add(v);
    return out;
  }
}

/** Expected number of legs of a fitting from its name (0 = unknown). */
function expectedLegs(ctx: ImportContext, h: Host): number {
  const n = `${ctx.label(h.el.src) ?? ''} ${str(ctx.model.line(h.el.src)?.ObjectType) ?? ''}`.toLowerCase();
  if (/cross|kreuz/.test(n)) return 4;
  if (/\btee\b|t-stück|wye|junction|abzweig/.test(n)) return 3;
  if (/\bcap\b|kappe|plug/.test(n)) return 1;
  if (/elbow|bend|bogen|transition|reduc|coupling|union|übergang/.test(n)) return 2;
  return 0;
}

function compatible(systems: Systems, a: OutEl, b: OutEl): boolean {
  const ka = systems.keysOf(a), kb = systems.keysOf(b);
  return ka.length === 0 || kb.length === 0 || ka.some(k => kb.includes(k));
}

/**
 * Connections of port-less runs by geometry: an end in (or on) a host body,
 * an end on another run's end, an end on another run's side; then fittings
 * still short of the legs their name promises, touching another host.
 */
function inferLinks(ctx: ImportContext, curves: Curve[], hosts: Host[], systems: Systems, links: [Slot, Slot][]): number {
  const loose = curves.filter(c => c.ports.length === 0);
  if (loose.length === 0) return 0;
  const hostGrid = new Grid<Host>();
  for (const h of hosts) hostGrid.insert(h.min, h.max, h);
  const curveGrid = new Grid<Curve>();
  for (const c of curves) {
    const n = Math.max(1, Math.ceil(curveLen(c) / (CELL / 2)));
    for (let i = 0; i <= n; i++) {
      const p = add3(c.a, scale3(sub3(c.b, c.a), i / n));
      const r = c.size / 2;
      curveGrid.insert(sub3(p, { x: r, y: r, z: r }), add3(p, { x: r, y: r, z: r }), c);
    }
  }
  let n = 0;
  const legCount = new Map<Host, number>();
  const linkedEnd = new Set<string>();
  const endKey = (c: Curve, e: 0 | 1) => `${curves.indexOf(c)}:${e}`;
  for (const c of loose) {
    // Hosts at each end (in / on the body, the nearer centre first); the two
    // ends never take the same host (a short run inside two fitting boxes)
    const tol = Math.max(0.02, 0.15 * c.size);
    const cands = ([0, 1] as const).map(e => {
      const p = endOf(c, e);
      // Devices and accessories may join systems (a backflow preventer, a boiler); fittings may not
      return [...hostGrid.near(p, tol)].filter(h => (!h.passive || compatible(systems, c.el, h.el)) && boxDist(p, h) <= tol)
        .map(h => ({ h, cost: boxDist(p, h) + 1e-3 * len3(sub3(p, mid(h))) })).sort((x, y) => x.cost - y.cost);
    });
    const pick: (Host | null)[] = [cands[0][0]?.h ?? null, cands[1][0]?.h ?? null];
    if (pick[0] && pick[0] === pick[1]) {
      const alt0 = cands[0][1], alt1 = cands[1][1];
      const keep0 = cands[0][0].cost + (alt1?.cost ?? tol), keep1 = cands[1][0].cost + (alt0?.cost ?? tol);
      if (keep0 <= keep1) pick[1] = alt1?.h ?? null; else pick[0] = alt0?.h ?? null;
    }
    for (const e of [0, 1] as const) {
      if (linkedEnd.has(endKey(c, e))) continue;
      const p = endOf(c, e);
      const bestH = pick[e];
      if (bestH) {
        links.push([{ k: 'end', c, end: e }, { k: 'host', h: bestH }]);
        legCount.set(bestH, (legCount.get(bestH) ?? 0) + 1);
        linkedEnd.add(endKey(c, e));
        n++;
        continue;
      }
      // Another run: end to end, else on its side
      let side: { o: Curve; t: number; d: number } | null = null;
      let joined = false;
      for (const o of curveGrid.near(p, tol + 1)) {
        if (o === c || o.el.table !== c.el.table || !compatible(systems, c.el, o.el)) continue;
        for (const oe of [0, 1] as const) {
          if (len3(sub3(p, endOf(o, oe))) > Math.max(0.02, 0.1 * Math.min(c.size, o.size))) continue;
          if (linkedEnd.has(endKey(o, oe))) continue;
          links.push([{ k: 'end', c, end: e }, { k: 'end', c: o, end: oe }]);
          linkedEnd.add(endKey(c, e)); linkedEnd.add(endKey(o, oe));
          joined = true;
          n++;
          break;
        }
        if (joined) break;
        const pr = project(p, o.a, o.b);
        const L = curveLen(o);
        if (pr.t * L > 0.02 && (1 - pr.t) * L > 0.02 && pr.d <= o.size / 2 + tol && (!side || pr.d < side.d)) side = { o, t: pr.t, d: pr.d };
      }
      if (!joined && side) {
        links.push([{ k: 'end', c, end: e }, { k: 'body', c: side.o, t: side.t }]);
        linkedEnd.add(endKey(c, e));
        n++;
      }
    }
  }
  // Fittings joined straight to another host (elbow on tee, fixture on a fitting)
  const portless = hosts.filter(h => h.ports.length === 0 && h.passive && !h.added);
  for (const h of portless) {
    const want = expectedLegs(ctx, h);
    let have = legCount.get(h) ?? 0;
    if (!want || have >= want) continue;
    const r = Math.max(h.max.x - h.min.x, h.max.y - h.min.y, h.max.z - h.min.z);
    for (const o of hostGrid.near(mid(h), r)) {
      if (o === h || o.ports.length > 0 || have >= want || !compatible(systems, h.el, o.el)) continue;
      const gap = Math.max(o.min.x - h.max.x, h.min.x - o.max.x, o.min.y - h.max.y, h.min.y - o.max.y, o.min.z - h.max.z, h.min.z - o.max.z);
      if (gap > Math.max(0.005, 0.25 * Math.min(r, Math.max(o.max.x - o.min.x, o.max.y - o.min.y, o.max.z - o.min.z)))) continue;
      if (links.some(([a, b]) => a.k === 'host' && b.k === 'host' && ((a.h === o && b.h === h) || (a.h === h && b.h === o)))) continue;
      links.push([{ k: 'host', h }, { k: 'host', h: o }]);
      have++;
      legCount.set(o, (legCount.get(o) ?? 0) + 1);
      n++;
    }
    legCount.set(h, have);
  }
  return n;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** A leg as the line through its end at the host, pointing away from the host. */
function legLine(pc: Piece, end: 0 | 1): { p: V3; dir: V3 } {
  const [p, q] = end === 0 ? [pc.a, pc.b] : [pc.b, pc.a];
  return { p, dir: norm3(sub3(q, p)) };
}

/** Least-squares meeting point of the legs' axes, kept near the fitting body. */
function fittingCenter(h: Host, legs: { p: V3; dir: V3 }[]): V3 | null {
  if (legs.length === 0) return null;
  const meanEnds = scale3(legs.reduce((s, l) => add3(s, l.p), { x: 0, y: 0, z: 0 }), 1 / legs.length);
  // Σ (I − d dᵀ) x = Σ (I − d dᵀ) p
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
  for (const { p, dir: d } of legs) {
    const dv = [d.x, d.y, d.z], pv = [p.x, p.y, p.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const m = (i === j ? 1 : 0) - dv[i] * dv[j];
      A[i * 3 + j] += m;
      b[i] += m * pv[j];
    }
  }
  const x = solve3(A, b);
  // Near the body, and every leg end within the editor's 2 m node reach (nearly parallel legs meet far away)
  const reach = Math.max(0.3, len3(sub3(h.max, h.min)));
  const ok = (p: V3) => len3(sub3(p, meanEnds)) <= reach && legs.every(l => len3(sub3(l.p, p)) <= 1.5);
  if (!x || !ok(x)) return h.added || legs.length < 2 || !ok(meanEnds) ? null : meanEnds;
  return x;
}

function solve3(A: number[], b: number[]): V3 | null {
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  // Parallel legs (coupling / reducer) leave the system singular along the run
  if (Math.abs(D) < 1e-6) return null;
  const col = (k: number) => A.map((v, i) => (i % 3 === k ? b[Math.floor(i / 3)] : v));
  return { x: det(col(0)) / D, y: det(col(1)) / D, z: det(col(2)) / D };
}

function moveHost(h: Host, p: V3): void {
  h.el.geometry = { type: 'Point', coordinates: pt(p) as [number, number, number] };
  if (h.added) { h.min = p; h.max = p; }
}

/**
 * Where a connector run from host `h` towards `other` starts: a node's centre;
 * on a device, the body face nearest the other host (its centre when that
 * would leave no run at all).
 */
function attachPoint(h: Host, other: Host): V3 {
  const at = (x: Host) => (x.el.table === 'mep_node' ? v3((x.el.geometry as { coordinates: number[] }).coordinates) : mid(x));
  if (h.el.table === 'mep_node') return at(h);
  const p = at(other);
  let q = clampBox(p, h);
  if (len3(sub3(q, p)) < 1e-6) {
    // Inside the body: out through the nearest face
    const faces: [keyof V3, number][] = [['x', h.min.x], ['x', h.max.x], ['y', h.min.y], ['y', h.max.y], ['z', h.min.z], ['z', h.max.z]];
    const [axis, v] = faces.reduce((b, f) => (Math.abs(p[f[0]] - f[1]) < Math.abs(p[b[0]] - b[1]) ? f : b));
    q = { ...p, [axis]: v };
  }
  return len3(sub3(q, p)) < 0.02 ? mid(h) : q;
}

/** Runs and passive fittings without a system take it from their neighbours; devices from their runs. */
function propagateSystems(systems: Systems, legsOf: Map<Host, { piece: Piece; end: 0 | 1 }[]>): void {
  const nbrs = new Map<OutEl, OutEl[]>();
  const link = (a: OutEl, b: OutEl) => {
    (nbrs.get(a) ?? nbrs.set(a, []).get(a)!).push(b);
    (nbrs.get(b) ?? nbrs.set(b, []).get(b)!).push(a);
  };
  for (const [h, legs] of legsOf) for (const l of legs) link(h.el, l.piece.el);
  const passes = (el: OutEl) => CURVES.has(el.table) || el.table === 'mep_node';
  const queue = [...nbrs.keys()].filter(el => systems.has(el) && passes(el));
  while (queue.length) {
    const el = queue.shift()!;
    for (const o of nbrs.get(el) ?? []) {
      if (!passes(o) || systems.has(o)) continue;
      if (systems.inherit(o, el)) queue.push(o);
    }
  }
  // Devices: the system of the run they sit on
  for (const [h, legs] of legsOf) {
    if (h.el.table === 'mep_node' || systems.has(h.el)) continue;
    for (const l of legs) if (systems.inherit(h.el, l.piece.el)) break;
  }
}
