/**
 * "Logical run" expansion for MEP curve drags.
 *
 * When the user grabs a single pipe and drags it, the *physical* intent is
 * usually to slide an entire straight run that the data layer has split
 * into multiple rows (because a tee fitting between collinear segments
 * splits the through-pipe into two pieces — see spec/mep-port-conventions
 * §4). This module walks the connection graph from every selected MEP
 * curve and collects:
 *   - every COLLINEAR sibling pipe reached through passive mep_node
 *     fittings (kind empty)
 *   - the passive mep_node ids encountered along the walk
 *
 * The selectTool feeds the expanded set to MOVE_ELEMENTS so the run
 * translates as a unit. The reducer's reverse-topology cascade then drags
 * BRANCH pipes (non-collinear pipes hanging off the run's tee nodes) by
 * the matching endpoint — i.e. branches stretch rather than stay put.
 *
 * Equipment / terminal ports are intentionally NOT followed. If a run is
 * pinned to a piece of equipment, the equipment-side endpoint translates
 * with the run while the equipment stays — visually the connection breaks
 * until the user repositions things. That matches the user request "if a
 * constraint can't be satisfied, just release it".
 */
import type { CanonicalElement, LineElement, SpatialLineElement } from './elements.ts';
import { isMepLineTable } from './mepTopology.ts';
import { parsePortRef, portRefTargetsHost } from '../utils/portRef.ts';

type MepCurve = LineElement | SpatialLineElement;

/** Two unit vectors are considered collinear when |dot| ≥ this threshold.
 *  cos(~2.6°) ≈ 0.999 — generous enough for hand-drawn pipes, tight
 *  enough that perpendicular branches never sneak into the run. */
const COLLINEAR_DOT_THRESHOLD = 0.999;

function isMepCurve(el: CanonicalElement | undefined | null): el is MepCurve {
  if (!el) return false;
  if (!isMepLineTable(el.tableName)) return false;
  return el.geometry === 'line' || el.geometry === 'spatial_line';
}

/** Resolve a host id (prefixed or unprefixed) to the actual mep_node row. */
function findMepNode(
  hostIdRef: string,
  elements: ReadonlyMap<string, CanonicalElement>,
): CanonicalElement | null {
  const direct = elements.get(hostIdRef);
  if (direct?.tableName === 'mep_node') return direct;
  for (const el of elements.values()) {
    if (el.tableName !== 'mep_node') continue;
    const colon = el.id.indexOf(':');
    const stripped = colon >= 0 ? el.id.substring(colon + 1) : el.id;
    if (stripped === hostIdRef || el.id === hostIdRef) return el;
  }
  return null;
}

/** Walk the topology from `seedPipeId` through passive (kind='') mep_nodes,
 *  collecting every collinear sibling pipe + the encountered passive node
 *  ids. The seed's own direction is the reference axis for the whole walk. */
export function collectCollinearRun(
  elements: ReadonlyMap<string, CanonicalElement>,
  seedPipeId: string,
): { pipes: Set<string>; nodes: Set<string> } {
  const out = { pipes: new Set<string>([seedPipeId]), nodes: new Set<string>() };
  const seed = elements.get(seedPipeId);
  if (!isMepCurve(seed)) return out;

  const refDx = seed.end.x - seed.start.x;
  const refDy = seed.end.y - seed.start.y;
  const refLen = Math.hypot(refDx, refDy);
  if (refLen < 1e-6) return out;
  const refDirX = refDx / refLen;
  const refDirY = refDy / refLen;
  const seedSystem = seed.attrs.system_type ?? '';

  const queue: string[] = [seedPipeId];
  while (queue.length > 0) {
    const curId = queue.shift()!;
    const curEl = elements.get(curId);
    if (!isMepCurve(curEl)) continue;

    for (const ref of [curEl.attrs.from, curEl.attrs.to]) {
      const parsed = parsePortRef(ref);
      if (!parsed) continue;

      const node = findMepNode(parsed.hostId, elements);
      if (!node) continue;
      // Active fittings (valves, dampers, pumps with explicit kind) anchor
      // the chain — don't slide across them.
      if ((node.attrs.kind ?? '').trim()) continue;

      out.nodes.add(node.id);

      // Find siblings at this node.
      for (const other of elements.values()) {
        if (other.id === curId) continue;
        if (out.pipes.has(other.id)) continue;
        if (!isMepCurve(other)) continue;
        if ((other.attrs.system_type ?? '') !== seedSystem) continue;
        if (
          !portRefTargetsHost(other.attrs.from, node.id) &&
          !portRefTargetsHost(other.attrs.to, node.id)
        ) continue;

        // Collinearity test against the run's reference axis.
        const dx = other.end.x - other.start.x;
        const dy = other.end.y - other.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const dot = Math.abs((dx / len) * refDirX + (dy / len) * refDirY);
        if (dot < COLLINEAR_DOT_THRESHOLD) continue;

        out.pipes.add(other.id);
        queue.push(other.id);
      }
    }
  }

  return out;
}

/** Expand a raw-id selection set so each MEP pipe in it pulls its whole
 *  collinear run + encountered passive nodes along for the ride. Non-MEP
 *  selections pass through unchanged. */
export function expandSelectionForCoMove(
  elements: ReadonlyMap<string, CanonicalElement>,
  rawIds: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of rawIds) {
    out.add(id);
    const el = elements.get(id);
    if (!isMepCurve(el)) continue;
    const run = collectCollinearRun(elements, id);
    for (const p of run.pipes) out.add(p);
    for (const n of run.nodes) out.add(n);
  }
  return out;
}

/** Given the set that will be passed to MOVE_ELEMENTS, return every id whose
 *  pre-drag state needs to be captured for a clean undo — including pipes
 *  that the reducer's cascade will partial-move (branches hanging off the
 *  passive mep_nodes that are inside the move set). */
export function collectCascadeBranches(
  elements: ReadonlyMap<string, CanonicalElement>,
  moveIds: Iterable<string>,
): Set<string> {
  const branches = new Set<string>();
  const moveSet = new Set(moveIds);
  for (const id of moveSet) {
    const node = elements.get(id);
    if (!node || node.tableName !== 'mep_node') continue;
    // Find every pipe referencing this node that ISN'T already in the move
    // set — those will be partial-moved (one endpoint follows the node).
    for (const el of elements.values()) {
      if (!isMepCurve(el)) continue;
      if (moveSet.has(el.id)) continue;
      if (
        portRefTargetsHost(el.attrs.from, node.id) ||
        portRefTargetsHost(el.attrs.to, node.id)
      ) {
        branches.add(el.id);
      }
    }
  }
  return branches;
}
