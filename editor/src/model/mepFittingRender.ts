/**
 * Render-time reconstruction of passive MEP fittings (non-destructive).
 *
 * Revit exports MEP curves whose endpoints sit at the *connector faces* of the
 * adjacent fitting, not at the centerline corner — so two ducts meeting at an
 * elbow are separated by a gap (the fitting body) with a passive `mep_node`
 * sitting on the corner (the intersection of the two curve axes). The editor
 * builds run continuity from coincident endpoints, so that gap reads as a
 * broken run with a stray node dot floating in it.
 *
 * This module closes the gap WITHOUT mutating data: for the geometry pass only,
 * any MEP curve endpoint that references a *passive* mep_node (empty `kind`) is
 * snapped onto that node's position. The snapped curves then share the node
 * point, so the existing miter / junction logic (see `_mepLineShared`) renders
 * the run as a continuous band and the fitting emerges from the join — an elbow
 * bends, a tee joins 3-way, a reducer shows a clean width step. The underlying
 * `mep_node` rows stay untouched, preserving Revit round-trip fidelity.
 *
 * Excluded from snapping: active accessories (non-empty `kind` — valve, damper,
 * pump …), `equipment`, and `terminal`. Their endpoints stay at the connector
 * face so the real device body still shows in the gap.
 *
 * Snapping is X/Y only; the curve keeps its own Z. The dominant planar case
 * (elbows / tees whose two curves share a level) becomes continuous in both 2D
 * plan and 3D. Non-planar riser fittings remain approximate — a pre-existing
 * limitation of the same-Z miter network.
 */
import type { LineElement, SpatialLineElement, Point } from './elements.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import { analyzeFittings } from '../mep/fittings.ts';

type MepCurve = LineElement | SpatialLineElement;

/** Memoized map of passive mep_node id (raw + level-stripped) → plan position.
 *  Active accessories (`kind` set) are excluded so their gap/body is preserved. */
export function passiveNodeMap(ctx: GeometryContext): Map<string, Point> {
  return ctx.memo('mep:passive-node-pos', () => {
    const map = new Map<string, Point>();
    for (const el of ctx.elementsByTable('mep_node')) {
      if (el.geometry !== 'point') continue;
      if ((el.attrs.kind ?? '').trim()) continue; // active accessory — keep its gap
      map.set(el.id, el.position);
      const colon = el.id.indexOf(':');
      if (colon >= 0) map.set(el.id.substring(colon + 1), el.position);
    }
    return map;
  });
}

/**
 * Return the curve unchanged, or a shallow clone whose ends are put on the
 * passive mep_node(s) they reference and then pulled back by the fitting arm
 * (see `mep/fittings.ts`), so the run stops at the fitting face and the node
 * draws the elbow / tee / reducer body in between.
 *
 * Ends are matched to nodes by proximity, not by column order (Revit emits
 * some curves reversed), and only within a 2 m reach so a stale or long ref
 * never yanks a line across the floor.
 */
export function effectiveMepLine<T extends MepCurve>(ln: T, ctx: GeometryContext): T {
  const adj = analyzeFittings(ctx).ends.get(ln.id);
  if (!adj || (!adj.start && !adj.end)) return ln;
  const clone: T = { ...ln };
  const spatial = ln.geometry === 'spatial_line';
  if (adj.start) {
    clone.start = { x: adj.start[0], y: adj.start[1] };
    if (spatial) (clone as SpatialLineElement).startZ = adj.start[2];
  }
  if (adj.end) {
    clone.end = { x: adj.end[0], y: adj.end[1] };
    if (spatial) (clone as SpatialLineElement).endZ = adj.end[2];
  }
  return clone;
}
