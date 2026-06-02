/**
 * Endpoint bonding for MEP curves.
 *
 * When two MEP curve endpoints (pipe / duct / conduit / cable_tray) sit at
 * the same world position, they SHOULD be topologically connected via a
 * shared `mep_node` host id (referenced from each pipe's `from` or `to`).
 * Without that node the BimDown topology layer treats the pipes as two
 * disconnected runs — even though visually they meet.
 *
 * This helper scans a set of candidate pipes and:
 *   1. Finds open endpoints (empty `from` / `to`).
 *   2. Looks for OTHER MEP curve endpoints (any side) within tolerance,
 *      restricted to the same `system_type`.
 *   3. Also looks for existing `mep_node` points at the same position.
 *   4. Picks (or creates) a passive mep_node and wires every matching open
 *      ref to it.
 *
 * Returns the set of NEW elements + UPDATED pipes. The caller is responsible
 * for merging the result into the document map AND the history before/after
 * maps so undo restores the un-bonded state cleanly.
 */
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement } from './elements.ts';
import { generateId } from './ids.ts';
import { isMepLineTable } from './mepTopology.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { findPipeBodyHit } from '../utils/pipeBodyHit.ts';

const DEFAULT_TOLERANCE = 0.01; // 1 cm in meters

type MepCurve = LineElement | SpatialLineElement;

interface BondingResult {
  /** Brand-new rows the bonding pass authored. Includes passive mep_nodes
   *  and (for body T-junctions) the downstream half of a split target pipe. */
  newElements: CanonicalElement[];
  /** Updated existing rows. For T-junctions the target pipe's row appears
   *  here with its `end` snapped to the split point and `to` re-wired. */
  updates: Map<string, CanonicalElement>;
}

function distSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isMepCurve(el: CanonicalElement | undefined | null): el is MepCurve {
  if (!el) return false;
  if (!isMepLineTable(el.tableName)) return false;
  return el.geometry === 'line' || el.geometry === 'spatial_line';
}

/** Resolve a port-ref back to the host element id (if it points at one). */
function resolveExistingNodeId(
  ref: string | undefined,
  elements: ReadonlyMap<string, CanonicalElement>,
): string | null {
  const parsed = parsePortRef(ref);
  if (!parsed) return null;
  const host = elements.get(parsed.hostId);
  if (host?.tableName === 'mep_node') return host.id;
  // Try unprefixed (level-id form).
  for (const el of elements.values()) {
    if (el.tableName !== 'mep_node') continue;
    const colon = el.id.indexOf(':');
    const stripped = colon >= 0 ? el.id.substring(colon + 1) : el.id;
    if (stripped === parsed.hostId) return el.id;
  }
  return null;
}

export interface BondEndpointsOptions {
  tolerance?: number;
  /** When true, also bond endpoints to existing mep_node points sitting at
   *  the same world position. Defaults to true. */
  reuseExistingNodes?: boolean;
}

/**
 * Run the bonding pass over `candidatePipeIds`.
 * @param elements live document elements map (read-only)
 * @param candidatePipeIds pipes whose endpoints may need bonding
 * @returns null when no bonding patches are needed
 */
export function bondEndpoints(
  elements: ReadonlyMap<string, CanonicalElement>,
  candidatePipeIds: Iterable<string>,
  opts: BondEndpointsOptions = {},
): BondingResult | null {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const tolSq = tol * tol;
  const reuseExisting = opts.reuseExistingNodes ?? true;

  const newElements: CanonicalElement[] = [];
  const updates = new Map<string, CanonicalElement>();
  // Track allocated ids so we don't collide with each other.
  const usedIds = new Set(elements.keys());

  // Helper: read the latest version of any element (mutation in flight).
  const liveElement = (id: string): CanonicalElement | null => {
    const updated = updates.get(id);
    if (updated) return updated;
    for (const el of newElements) if (el.id === id) return el;
    return elements.get(id) ?? null;
  };
  const liveCurve = (id: string): MepCurve | null => {
    const el = liveElement(id);
    return isMepCurve(el) ? el : null;
  };
  /** Iterate every MEP curve in the live view (updates + newElements +
   *  unchanged elements). PASS 2 uses this so it sees splits-in-flight. */
  function* liveCurves(): Generator<MepCurve> {
    const seen = new Set<string>();
    for (const [id, el] of updates) {
      if (isMepCurve(el)) { yield el; seen.add(id); }
    }
    for (const el of newElements) {
      if (seen.has(el.id)) continue;
      if (isMepCurve(el)) { yield el; seen.add(el.id); }
    }
    for (const el of elements.values()) {
      if (seen.has(el.id)) continue;
      if (isMepCurve(el)) yield el;
    }
  }

  // Index existing mep_node positions for fast lookup when reusing.
  const meps: { id: string; pos: { x: number; y: number }; sysType: string }[] = [];
  if (reuseExisting) {
    for (const el of elements.values()) {
      if (el.tableName !== 'mep_node' || el.geometry !== 'point') continue;
      const p = el as PointElement;
      meps.push({ id: p.id, pos: p.position, sysType: p.attrs.system_type ?? '' });
    }
  }

  // Bucket all MEP curve endpoints by rounded position so the inner search
  // stays O(neighbors) instead of O(curves).
  const cellSize = Math.max(tol * 4, 0.05);
  const bucketKey = (pos: { x: number; y: number }) =>
    `${Math.round(pos.x / cellSize)}|${Math.round(pos.y / cellSize)}`;
  type EndpointEntry = { id: string; side: 'start' | 'end'; sysType: string; pos: { x: number; y: number } };
  const buckets = new Map<string, EndpointEntry[]>();
  for (const el of elements.values()) {
    if (!isMepCurve(el)) continue;
    const sys = el.attrs.system_type ?? '';
    for (const side of ['start', 'end'] as const) {
      const pos = side === 'start' ? el.start : el.end;
      const entry: EndpointEntry = { id: el.id, side, sysType: sys, pos };
      const key = bucketKey(pos);
      const list = buckets.get(key) ?? [];
      list.push(entry);
      buckets.set(key, list);
    }
  }

  const neighborKeys = (pos: { x: number; y: number }) => {
    const bx = Math.round(pos.x / cellSize);
    const by = Math.round(pos.y / cellSize);
    return [
      `${bx - 1}|${by - 1}`, `${bx}|${by - 1}`, `${bx + 1}|${by - 1}`,
      `${bx - 1}|${by}`,     `${bx}|${by}`,     `${bx + 1}|${by}`,
      `${bx - 1}|${by + 1}`, `${bx}|${by + 1}`, `${bx + 1}|${by + 1}`,
    ];
  };

  for (const candidateId of candidatePipeIds) {
    for (const side of ['start', 'end'] as const) {
      const refKey = side === 'start' ? 'from' : 'to';
      const live = liveCurve(candidateId);
      if (!live) continue;
      if (live.attrs[refKey]) continue;
      const endpoint = side === 'start' ? live.start : live.end;
      const sysType = live.attrs.system_type ?? '';

      // Scan neighbours for coincident endpoints (skip self-same side).
      type Match = { id: string; side: 'start' | 'end' };
      const matches: Match[] = [];
      for (const key of neighborKeys(endpoint)) {
        const list = buckets.get(key);
        if (!list) continue;
        for (const entry of list) {
          if (entry.id === candidateId && entry.side === side) continue;
          if (entry.sysType !== sysType) continue;
          if (distSq(entry.pos, endpoint) > tolSq) continue;
          matches.push({ id: entry.id, side: entry.side });
        }
      }

      let existingNodeId: string | null = null;
      if (reuseExisting) {
        for (const m of meps) {
          if (m.sysType && sysType && m.sysType !== sysType) continue;
          if (distSq(m.pos, endpoint) <= tolSq) {
            existingNodeId = m.id;
            break;
          }
        }
      }

      // ── PASS 2: endpoint sits ON another pipe's body (T-junction) ──
      // Only runs when PASS 1 yielded nothing. Splits the target pipe at
      // the projection point, drops a passive mep_node, wires self.
      if (matches.length === 0 && !existingNodeId) {
        const liveTargets = new Map<string, MepCurve>();
        for (const c of liveCurves()) liveTargets.set(c.id, c);
        const excludeIds = new Set<string>([candidateId]);
        // Also exclude any pipe that's already been replaced by a split
        // (its row was rewritten under the same id and might have a
        // misleading geometry compared to the original).
        // PASS 2 uses a more generous tolerance than the endpoint-to-
        // endpoint pass: clicking "on the pipe" should count even if the
        // click isn't exactly on the centreline. findPipeBodyHit folds in
        // the target's stroke half-width + a pick-padding on top of this
        // floor, so big ducts get fatter hit zones automatically.
        const bodyHit = findPipeBodyHit(endpoint, liveTargets, {
          tolerance: 0.15,
          pickPadding: 0.15,
          systemType: sysType || undefined,
          excludeIds,
        });
        if (bodyHit) {
          const target = bodyHit.pipe as MepCurve;
          const splitPoint = bodyHit.point;
          // Allocate the tee node + downstream-half pipe id.
          const tNodeId = generateId('mep_node', usedIds);
          usedIds.add(tNodeId);
          const newDownstreamId = generateId(target.tableName, usedIds);
          usedIds.add(newDownstreamId);

          const isSpatial = target.geometry === 'spatial_line';
          const spatial = target as unknown as { startZ?: number; endZ?: number };

          // Upstream half (existing id, new end + new attrs.to).
          const updatedTarget: MepCurve = {
            ...target,
            end: { x: splitPoint.x, y: splitPoint.y },
            ...(isSpatial ? { endZ: spatial.startZ ?? 0 } : {}),
            attrs: { ...target.attrs, to: tNodeId },
          } as MepCurve;
          updates.set(target.id, updatedTarget);

          // Downstream half (brand-new row carrying the original tail).
          const newDownstream: MepCurve = {
            ...target,
            id: newDownstreamId,
            start: { x: splitPoint.x, y: splitPoint.y },
            ...(isSpatial ? { startZ: spatial.endZ ?? 0 } : {}),
            attrs: {
              ...target.attrs,
              id: newDownstreamId,
              from: tNodeId,
              to: target.attrs.to ?? '',
            },
          } as MepCurve;
          newElements.push(newDownstream);

          // New passive mep_node at the T.
          const tNode: PointElement = {
            id: tNodeId,
            tableName: 'mep_node',
            discipline: 'mep',
            geometry: 'point',
            position: { x: splitPoint.x, y: splitPoint.y },
            width: 0,
            height: 0,
            attrs: {
              id: tNodeId,
              number: '',
              system_type: sysType,
              kind: '',
            },
          };
          newElements.push(tNode);

          // Snap the candidate's own endpoint to splitPoint and wire its ref.
          const selfCurve = liveCurve(candidateId);
          if (selfCurve) {
            const snapped: MepCurve = {
              ...selfCurve,
              ...(side === 'start'
                ? { start: { x: splitPoint.x, y: splitPoint.y } }
                : { end:   { x: splitPoint.x, y: splitPoint.y } }),
              attrs: { ...selfCurve.attrs, [refKey]: tNodeId },
            } as MepCurve;
            updates.set(candidateId, snapped);
          }
          continue;
        }
        continue;
      }

      // Decide the node id. Precedence:
      //   1. An existing mep_node at this position.
      //   2. An already-wired matching pipe — reuse the node it points at.
      //   3. A freshly allocated passive mep_node.
      let nodeId: string | null = existingNodeId;

      if (!nodeId) {
        for (const m of matches) {
          const other = liveCurve(m.id);
          if (!other) continue;
          const otherRef = m.side === 'start' ? other.attrs.from : other.attrs.to;
          const resolved = resolveExistingNodeId(otherRef, elements);
          if (resolved) { nodeId = resolved; break; }
        }
      }

      if (!nodeId) {
        const newId = generateId('mep_node', usedIds);
        usedIds.add(newId);
        nodeId = newId;
        const node: PointElement = {
          id: newId,
          tableName: 'mep_node',
          discipline: 'mep',
          geometry: 'point',
          position: { x: endpoint.x, y: endpoint.y },
          width: 0,
          height: 0,
          attrs: {
            id: newId,
            number: '',
            system_type: sysType,
            kind: '',
          },
        };
        newElements.push(node);
      }

      // Wire self.
      const selfCurve = liveCurve(candidateId);
      if (selfCurve) {
        updates.set(candidateId, {
          ...selfCurve,
          attrs: { ...selfCurve.attrs, [refKey]: nodeId },
        } as MepCurve);
      }

      // Wire matches that don't yet reference a node.
      for (const m of matches) {
        const other = liveCurve(m.id);
        if (!other) continue;
        const otherRefKey = m.side === 'start' ? 'from' : 'to';
        if (other.attrs[otherRefKey]) continue;
        updates.set(m.id, {
          ...other,
          attrs: { ...other.attrs, [otherRefKey]: nodeId },
        } as MepCurve);
      }
    }
  }

  if (newElements.length === 0 && updates.size === 0) return null;
  return { newElements, updates };
}
