/**
 * Helpers for snapping MEP line drawing tools to connector ports.
 *
 * Connectors are PointElements in the `connector` table whose absolute world
 * position is derived from their host (equipment/terminal/mep_node) at render
 * time. The drawing tool needs the same resolution to feed snap points into
 * the snap pipeline AND to render preview dots in the overlay.
 *
 * Kept independent from the element module's `geometry()` pass because tools
 * don't have a GeometryContext — they only see the raw elements map.
 */
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import type { ConnectorSnapPoint } from './snap.ts';

const MEP_LINE_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

/** Is this table one of the MEP line types that should snap to connectors? */
export function isMepLineTable(tableName: string | undefined | null): boolean {
  return !!tableName && MEP_LINE_TABLES.has(tableName);
}

function rotate2D(x: number, y: number, deg: number): { x: number; y: number } {
  if (deg === 0) return { x, y };
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * x - s * y, y: s * x + c * y };
}

function resolveHost(
  hostId: string,
  elements: ReadonlyMap<string, CanonicalElement>,
): { pos: Point; rotationDeg: number } | null {
  if (!hostId) return null;
  // Direct lookup first; fall back to scanning by unprefixed id since
  // host_id in CSV may carry either form (level-scoped IDs are stored both
  // with and without the `lv-N:` prefix in different parts of the editor).
  let host: CanonicalElement | undefined = elements.get(hostId);
  if (!host) {
    for (const el of elements.values()) {
      const colonIdx = el.id.indexOf(':');
      const unprefixed = colonIdx >= 0 ? el.id.substring(colonIdx + 1) : el.id;
      if (unprefixed === hostId) { host = el; break; }
    }
  }
  if (!host) return null;
  if (host.geometry !== 'point') return null;
  const p = host as PointElement;
  const rotationDeg = parseFloat(p.attrs.rotation || '0') || 0;
  return { pos: p.position, rotationDeg };
}

/**
 * Walk the elements map, collect every connector that resolves to a valid
 * host, and return its world-space snap target. The `hostId` returned is the
 * host element's own id (as it appears in the elements map), so the drawing
 * tool can wire start_node_id / end_node_id directly.
 */
export function gatherConnectorSnapPoints(
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
): ConnectorSnapPoint[] {
  if (!elements) return [];
  const out: ConnectorSnapPoint[] = [];
  for (const el of elements.values()) {
    if (el.tableName !== 'connector') continue;
    if (el.geometry !== 'point') continue;
    const p = el as PointElement;
    const hostIdRaw = p.hostId || p.attrs.host_id || '';
    const host = resolveHost(hostIdRaw, elements);
    if (!host) continue;

    const ox = parseFloat(p.attrs.offset_x || '0') || 0;
    const oy = parseFloat(p.attrs.offset_y || '0') || 0;
    const dx = parseFloat(p.attrs.dir_x || '1');
    const dy = parseFloat(p.attrs.dir_y || '0');

    const off = rotate2D(ox, oy, host.rotationDeg);
    const pos: Point = { x: host.pos.x + off.x, y: host.pos.y + off.y };
    const dirRaw = rotate2D(isNaN(dx) ? 1 : dx, isNaN(dy) ? 0 : dy, host.rotationDeg);
    const len = Math.sqrt(dirRaw.x * dirRaw.x + dirRaw.y * dirRaw.y);
    const dir = len > 1e-6 ? { x: dirRaw.x / len, y: dirRaw.y / len } : { x: 1, y: 0 };

    // Resolve to the *actual* host id present in the elements map so the
    // start_node_id / end_node_id link uses the same form the topology
    // cascade expects.
    let hostId = hostIdRaw;
    if (!elements.has(hostIdRaw)) {
      for (const candidate of elements.values()) {
        const colonIdx = candidate.id.indexOf(':');
        const unprefixed = colonIdx >= 0 ? candidate.id.substring(colonIdx + 1) : candidate.id;
        if (unprefixed === hostIdRaw) { hostId = candidate.id; break; }
      }
    }

    out.push({ pos, dir, hostId });
  }
  return out;
}
