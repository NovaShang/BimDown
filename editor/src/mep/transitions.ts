/**
 * Transitions at device ports: a run whose size differs from the port it
 * ends on gets a short stub at the port's size next to it, joined by a
 * passive node (drawn as a reducer / transition). Used by the check's fix
 * button and by system sizing.
 */
import type { CanonicalElement, LineElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { endZ } from '../model/mepSplit.ts';
import { findConnectorByPort, findHostElement, parsePortRef } from '../utils/portRef.ts';
import { portInfo, sameSize } from './routeTool.ts';

type MepCurve = LineElement | SpatialLineElement;

const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };

/** Port section of a `host:port` ref (shape / w / h strings), if it is a device port. */
export function portSection(ref: string | undefined, elements: ReadonlyMap<string, CanonicalElement>): { shape: string; w: string; h: string } | null {
  const p = parsePortRef(ref);
  if (!p?.portName) return null;
  const host = findHostElement(p.hostId, elements);
  const conn = findConnectorByPort(p.hostId, p.portName, elements);
  if (!host || !conn || (conn.attrs.domain ?? '') === 'electrical') return null;
  return { shape: (conn.attrs.shape ?? '').trim(), w: (conn.attrs.size_w ?? '').trim(), h: (conn.attrs.size_h ?? '').trim() };
}

/** Section attrs a run of `table` takes from a port section. */
function sectionAttrs(port: { shape: string; w: string; h: string }, table: string): Record<string, string> {
  const round = table === 'pipe' || table === 'conduit' || port.shape === 'round' || !num(port.h);
  const out: Record<string, string> = { size_x: port.w, size_y: round ? port.w : port.h };
  if (table === 'duct' || table === 'cable_tray') out.shape = round ? 'round' : 'rect';
  return out;
}

/**
 * Elements (the shortened run, the stub at port size and the node between)
 * that put a transition at the `side` end of `curve`, or null when the
 * sizes already match or the run is too short.
 */
export function transitionAtPort(
  curve: MepCurve,
  side: 'from' | 'to',
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Set<string>,
  levelId: string,
): CanonicalElement[] | null {
  const ref = curve.attrs[side];
  const port = portSection(ref, elements);
  if (!port || !num(port.w) || sameSize(curve.attrs, port, curve.tableName)) return null;
  // Which geometric end sits on the port: the nearer one (imported runs may be reversed).
  const pi = portInfo(ref!, elements);
  const atStart = pi
    ? Math.hypot(curve.start.x - pi.at.x, curve.start.y - pi.at.y, endZ(curve, 'start') - pi.z) <= Math.hypot(curve.end.x - pi.at.x, curve.end.y - pi.at.y, endZ(curve, 'end') - pi.z)
    : side === 'from';
  const near = atStart ? curve.start : curve.end, far = atStart ? curve.end : curve.start;
  const zNear = endZ(curve, atStart ? 'start' : 'end'), zFar = endZ(curve, atStart ? 'end' : 'start');
  const L = Math.hypot(far.x - near.x, far.y - near.y, zFar - zNear);
  if (L < 0.12) return null;
  const sec = sectionAttrs(port, curve.tableName);
  const step = Math.max(Math.abs(num(curve.attrs.size_x) - num(sec.size_x)), Math.abs(num(curve.attrs.size_y) - num(sec.size_y)), 0.05);
  const want = Math.max(0.15, (step / 2) / Math.tan((20 * Math.PI) / 180) + 0.05);
  const t = Math.min(0.5, want / L);
  const m = { x: near.x + (far.x - near.x) * t, y: near.y + (far.y - near.y) * t };
  const zm = Math.round((zNear + (zFar - zNear) * t) * 1e4) / 1e4;
  const nodeId = generateId('mep_node', ids); ids.add(nodeId);
  const stubId = generateId(curve.tableName, ids); ids.add(stubId);
  const spatial = curve.geometry === 'spatial_line';
  const run = {
    ...curve,
    ...(atStart ? { start: m } : { end: m }),
    ...(spatial ? (atStart ? { startZ: zm } : { endZ: zm }) : {}),
    attrs: { ...curve.attrs, [side]: nodeId, ...(spatial ? (atStart ? { start_z: String(zm) } : { end_z: String(zm) }) : {}) },
  } as MepCurve;
  const stubAttrs: Record<string, string> = { ...curve.attrs, ...sec, id: stubId, number: '' };
  stubAttrs[side] = ref!;
  stubAttrs[side === 'from' ? 'to' : 'from'] = nodeId;
  const stub = {
    ...curve, id: stubId,
    start: atStart ? near : m, end: atStart ? m : near,
    ...(spatial ? { startZ: atStart ? zNear : zm, endZ: atStart ? zm : zNear } : {}),
    strokeWidth: num(sec.size_x, curve.strokeWidth ?? 0.1),
    attrs: { ...stubAttrs, ...(spatial ? { start_z: String(atStart ? zNear : zm), end_z: String(atStart ? zm : zNear) } : {}) },
  } as MepCurve;
  const node: PointElement = {
    id: nodeId, tableName: 'mep_node', discipline: 'mep', geometry: 'point', position: { ...m }, width: 0, height: 0,
    attrs: { ...defaultAttrs('mep_node', levelId), id: nodeId, kind: '', system_type: curve.attrs.system_type ?? '', base_offset: String(zm) },
  };
  return [run, stub, node];
}

/** Transitions for every device-port end of `curves` whose size differs from the port. */
export function transitionsForRuns(
  curves: Iterable<MepCurve>,
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Set<string>,
  levelId: string,
): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  for (let c of curves) {
    for (const side of ['from', 'to'] as const) {
      const els = transitionAtPort(c, side, elements, ids, levelId);
      if (!els) continue;
      c = els[0] as MepCurve;
      out.push(...els.slice(1));
    }
    out.push(c);
  }
  return out;
}
