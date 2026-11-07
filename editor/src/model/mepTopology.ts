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

/** What a system carries, which decides the line tables it can run in. */
type Medium = 'air' | 'fluid' | 'electric';

const MEDIUM_TABLES: Record<Medium, readonly MepLineTable[]> = {
  air: ['duct'],
  fluid: ['pipe'],
  electric: ['conduit', 'cable_tray'],
};

/** Common system codes (Revit / ASHRAE style abbreviations). */
const AIR_CODES = /^(SA|RA|EA|OA|TA|FA|MA|SEA|SPA|SMK|SE|KEA|TEA|GEA)$/;
const FLUID_CODES = /^(CHWS|CHWR|CHW|CWS|CWR|CW|HWS|HWR|HW|HHWS|HHWR|DHWS|DHWR|DHW|DCW|DW|SAN|SW|V|VENT|CD|COND|G|GAS|FP|SPK|STM|RF|RW|REF)$/;
const ELECTRIC_CODES = /^(PWR|POWER|LTG|LIGHTING|DATA|COM|TEL|LV|EM)$/;

function mediumOf(system: { system_type: string; name?: string; discipline?: string }): Medium | null {
  const code = system.system_type.trim().toUpperCase();
  if (FLUID_CODES.test(code)) return 'fluid';
  if (AIR_CODES.test(code)) return 'air';
  if (ELECTRIC_CODES.test(code)) return 'electric';
  const text = `${system.system_type} ${system.name ?? ''}`.toLowerCase();
  if (/\bair\b|exhaust|ventilation|smoke/.test(text)) return 'air';
  if (/water|chilled|condenser|steam|sanit|drain|waste|sprinkler|gas|refriger|fuel/.test(text)) return 'fluid';
  if (/power|lighting|data|telecom|cable|electr/.test(text)) return 'electric';
  switch (system.discipline) {
    case 'plumbing': case 'fire': return 'fluid';
    case 'electrical': case 'data': return 'electric';
    default: return null; // hvac (air or water) / other: no opinion
  }
}

/**
 * Whether a project MEP system (`global/mep_system.csv` row) can run in a
 * given line table: air systems in ducts, water / gas / drainage in pipes,
 * power and data in conduit and cable tray. The toolbar and property-panel
 * system dropdowns filter with this. Systems whose medium can't be told (an
 * HVAC system with an unknown code) are offered everywhere.
 */
export function systemFitsTable(system: { system_type: string; name?: string; discipline?: string }, table: string): boolean {
  if (!isMepLineTable(table)) return true;
  const medium = mediumOf(system);
  return !medium || MEDIUM_TABLES[medium].includes(table);
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
