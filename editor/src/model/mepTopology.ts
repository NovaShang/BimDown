/**
 * Connectivity helpers for MEP line-archetype tables. Curves (duct / pipe /
 * conduit / cable_tray) connect to each other through shared host ids in
 * their `from` / `to` port references — typically a passive mep_node, but
 * also equipment / terminal hosts via "host_id:port_name".
 */
import type { CanonicalElement, LineElement, SpatialLineElement } from './elements.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { ptKey } from '../geometry/miter.ts';

export const MEP_LINE_TABLES = ['duct', 'pipe', 'conduit', 'cable_tray'] as const;
export type MepLineTable = typeof MEP_LINE_TABLES[number];

export function isMepLineTable(name: string): name is MepLineTable {
  return (MEP_LINE_TABLES as readonly string[]).includes(name);
}

/** MEP system disciplines (from `global/mep_system.csv` rows) that are
 *  meaningful for a given line table. A duct can carry HVAC supply/return
 *  or smoke-evac (fire); a pipe can be plumbing or fire sprinkler; conduit
 *  and cable tray serve power (electrical) and low-voltage (data). The
 *  toolbar / property-panel system dropdowns filter to these so users
 *  don't see e.g. plumbing systems on a duct. */
const MEP_LINE_DISCIPLINES: Record<MepLineTable, readonly string[]> = {
  duct: ['hvac', 'fire'],
  pipe: ['plumbing', 'fire'],
  conduit: ['electrical', 'data'],
  cable_tray: ['electrical', 'data'],
};

export function disciplinesForMepLine(table: string): readonly string[] | null {
  return isMepLineTable(table) ? MEP_LINE_DISCIPLINES[table] : null;
}

/** Strip an element-id prefix ("lv-1:eq-X" → "eq-X"). Used to bucket both
 *  prefixed and unprefixed host ids under one key. */
function unprefix(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.substring(i + 1) : id;
}

function readZ(ln: LineElement | SpatialLineElement): { startZ: number; endZ: number } {
  if (ln.geometry === 'spatial_line') {
    return { startZ: ln.startZ, endZ: ln.endZ };
  }
  const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
  return {
    startZ: parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset,
    endZ: parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset,
  };
}

/** Endpoint adjacency key: 2D ptKey + 1mm-quantized Z. Two curves are
 *  spatially adjacent at this endpoint if they produce the same key, which
 *  mirrors the same-Z-bucket merge logic used by 2D rendering. */
function endpointKey(x: number, y: number, z: number): string {
  return `${ptKey(x, y)}@${Math.round(z * 1000)}`;
}

/** BFS over MEP curves connected to `seed`, restricted to the same table
 *  and only crossing into neighbors whose current `system_type` equals
 *  `matchSys`. Returns the ids of every curve in the connected branch
 *  (including `seed`).
 *
 *  Adjacency is the union of two relations:
 *    1. **Port-ref hostId**: two curves reference the same host id via
 *       `from` or `to`. Both prefixed ("lv-1:nd-X") and unprefixed
 *       ("nd-X") forms map to the same bucket.
 *    2. **Shared endpoint at same Z**: two curves have an endpoint at the
 *       same (x, y, z) within 1mm — i.e. they visually merge at a junction.
 *       This catches chains drawn without explicit mep_node fittings.
 *
 *  Empty port-refs are ignored; only the spatial relation contributes
 *  there. The same matchSys filter gates both relations so a different-
 *  system neighbor still terminates the branch. */
export function collectMepBranch(
  elements: ReadonlyMap<string, CanonicalElement>,
  seed: CanonicalElement,
  matchSys: string,
): Set<string> {
  const table = seed.tableName;
  if (!isMepLineTable(table)) return new Set([seed.id]);

  const hostBucket = new Map<string, string[]>();
  const endpointBucket = new Map<string, string[]>();
  type AnyLine = LineElement | SpatialLineElement;
  const lineById = new Map<string, AnyLine>();
  const addTo = (bucket: Map<string, string[]>, key: string, id: string) => {
    const list = bucket.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    bucket.set(key, list);
  };
  for (const el of elements.values()) {
    if (el.tableName !== table) continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    const ln = el as AnyLine;
    lineById.set(ln.id, ln);
    for (const ref of [ln.attrs.from, ln.attrs.to]) {
      const parsed = parsePortRef(ref);
      if (!parsed || !parsed.hostId) continue;
      for (const key of [parsed.hostId, unprefix(parsed.hostId)]) addTo(hostBucket, key, ln.id);
    }
    const { startZ, endZ } = readZ(ln);
    addTo(endpointBucket, endpointKey(ln.start.x, ln.start.y, startZ), ln.id);
    addTo(endpointBucket, endpointKey(ln.end.x, ln.end.y, endZ), ln.id);
  }

  const neighborsOf = (ln: AnyLine): string[] => {
    const out = new Set<string>();
    for (const ref of [ln.attrs.from, ln.attrs.to]) {
      const parsed = parsePortRef(ref);
      if (!parsed || !parsed.hostId) continue;
      for (const key of [parsed.hostId, unprefix(parsed.hostId)]) {
        const list = hostBucket.get(key);
        if (list) for (const id of list) out.add(id);
      }
    }
    const { startZ, endZ } = readZ(ln);
    for (const [x, y, z] of [[ln.start.x, ln.start.y, startZ], [ln.end.x, ln.end.y, endZ]] as const) {
      const list = endpointBucket.get(endpointKey(x, y, z));
      if (list) for (const id of list) out.add(id);
    }
    out.delete(ln.id);
    return Array.from(out);
  };

  const visited = new Set<string>([seed.id]);
  const queue: string[] = [seed.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const ln = lineById.get(cur);
    if (!ln) continue;
    for (const nid of neighborsOf(ln)) {
      if (visited.has(nid)) continue;
      const nLine = lineById.get(nid);
      if (!nLine) continue;
      if ((nLine.attrs.system_type ?? '') !== matchSys) continue;
      visited.add(nid);
      queue.push(nid);
    }
  }
  return visited;
}
