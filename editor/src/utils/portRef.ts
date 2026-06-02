/**
 * Port-reference utilities for MEP topology.
 *
 * A port reference (in pipe.from / pipe.to) is a string of the form
 *   "host_id:port_name"   — references a specific connector row on the host
 * or
 *   "host_id"             — bare host reference, used for passive mep_node
 *                           fittings whose ports are derived from connected-
 *                           pipe geometry at runtime.
 *
 * Host ids in the elements map may carry a level prefix ("lv-1:eq-AHU-01")
 * while CSV-authored values may be unprefixed. Helpers in this module accept
 * both forms — see `findHostElement`.
 */
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';

/** Split a port-ref string into hostId + optional port name.
 *  Empty string → null. */
export function parsePortRef(ref: string | undefined | null): { hostId: string; portName: string | null } | null {
  if (!ref) return null;
  const s = ref.trim();
  if (!s) return null;
  const colon = s.indexOf(':');
  if (colon < 0) return { hostId: s, portName: null };
  return { hostId: s.substring(0, colon), portName: s.substring(colon + 1) };
}

/** Build a port-ref string. Empty `portName` returns bare host_id. */
export function formatPortRef(hostId: string, portName: string | null | undefined): string {
  if (!hostId) return '';
  if (!portName) return hostId;
  return `${hostId}:${portName}`;
}

/** Does the candidate match the prefixed-or-unprefixed form of hostId? */
function idMatches(candidateId: string, hostIdRef: string): boolean {
  if (candidateId === hostIdRef) return true;
  const colonIdx = candidateId.indexOf(':');
  if (colonIdx < 0) return false;
  return candidateId.substring(colonIdx + 1) === hostIdRef;
}

/** Resolve a host id (prefixed or unprefixed) to the actual element in the
 *  elements map. Returns null if no element matches. */
export function findHostElement(
  hostIdRef: string,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
): CanonicalElement | null {
  if (!hostIdRef || !elements) return null;
  const direct = elements.get(hostIdRef);
  if (direct) return direct;
  for (const el of elements.values()) {
    if (idMatches(el.id, hostIdRef)) return el;
  }
  return null;
}

/** Find the connector element whose host matches `hostIdRef` and whose
 *  `name` attr equals `portName`. Returns null if not found. */
export function findConnectorByPort(
  hostIdRef: string,
  portName: string,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
): PointElement | null {
  if (!elements || !portName) return null;
  for (const el of elements.values()) {
    if (el.tableName !== 'connector') continue;
    if (el.geometry !== 'point') continue;
    const p = el as PointElement;
    const hostRaw = p.hostId || p.attrs.host_id || '';
    if (!idMatches(hostRaw, hostIdRef) && hostRaw !== hostIdRef) {
      // also try the case where hostRaw is the long form and hostIdRef is short
      if (!(idMatches(hostIdRef, hostRaw))) continue;
    }
    if ((p.attrs.name || '') === portName) return p;
  }
  return null;
}

function rotate2D(x: number, y: number, deg: number): { x: number; y: number } {
  if (deg === 0) return { x, y };
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * x - s * y, y: s * x + c * y };
}

/** Compute the world-space position of a port-ref. For bare host refs this
 *  returns the host's own origin. For `host:port` refs it returns
 *  `host.origin + R(host.rotation) · port.offset`. */
export function resolvePortPosition(
  ref: string | undefined | null,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
): Point | null {
  const parsed = parsePortRef(ref);
  if (!parsed) return null;
  const host = findHostElement(parsed.hostId, elements);
  if (!host || host.geometry !== 'point') return null;
  const hostP = host as PointElement;
  if (!parsed.portName) return hostP.position;
  const conn = findConnectorByPort(parsed.hostId, parsed.portName, elements);
  if (!conn) return hostP.position; // unresolved port → fall back to host origin
  const ox = parseFloat(conn.attrs.offset_x || '0') || 0;
  const oy = parseFloat(conn.attrs.offset_y || '0') || 0;
  const rotationDeg = parseFloat(hostP.attrs.rotation || '0') || 0;
  const off = rotate2D(ox, oy, rotationDeg);
  return { x: hostP.position.x + off.x, y: hostP.position.y + off.y };
}

/** Does a port-ref `ref` reference any of the host ids in `hostIds`?
 *  Matches across prefixed/unprefixed and ignores port suffix. */
export function portRefTargetsHost(
  ref: string | undefined | null,
  hostId: string,
): boolean {
  const parsed = parsePortRef(ref);
  if (!parsed) return false;
  if (parsed.hostId === hostId) return true;
  return idMatches(hostId, parsed.hostId) || idMatches(parsed.hostId, hostId);
}
