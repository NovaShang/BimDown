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
import { parsePortRef } from '../utils/portRef.ts';

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

/** Resolve a port-ref's host to a passive node position, or null. */
function passiveTarget(ref: string | undefined, nodes: Map<string, Point>): Point | null {
  const parsed = parsePortRef(ref);
  if (!parsed) return null;
  return nodes.get(parsed.hostId) ?? null;
}

/** Max distance (m) an endpoint may be pulled onto a node. A real fitting sits
 *  a fitting-arm away (≤~0.35 m in practice); this leaves margin for large
 *  ducts. Beyond it the reference is not a local fitting — a terminal across the
 *  room, an open run, or a stale/long ref — and the endpoint is left untouched,
 *  which is what prevents lines from being yanked across the floor. */
const SNAP_TOL = 2.0;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Return the curve unchanged, or a shallow clone whose endpoints are snapped
 * (X/Y) onto the passive mep_node(s) they reference.
 *
 * Endpoints are matched to nodes by **proximity, not by column order**: the
 * GeoJSON coordinate order (`coords[0]`/`coords[-1]`) does NOT reliably match
 * the `from`/`to` order — Revit emits some curves reversed, so `from` is not
 * always the start endpoint. We therefore assign each endpoint to its nearest
 * referenced node and only snap within `SNAP_TOL`.
 */
export function effectiveMepLine<T extends MepCurve>(ln: T, ctx: GeometryContext): T {
  const nodes = passiveNodeMap(ctx);
  if (nodes.size === 0) return ln;
  const cands: Point[] = [];
  for (const ref of [ln.attrs.from, ln.attrs.to]) {
    const p = passiveTarget(ref, nodes);
    if (p) cands.push(p);
  }
  if (cands.length === 0) return ln;

  let snapStart: Point | null = null;
  let snapEnd: Point | null = null;
  if (cands.length >= 2) {
    // Two referenced nodes — pick the endpoint↔node pairing with lower total
    // distance, then tol-gate each side independently.
    const [c0, c1] = cands;
    const direct = dist(ln.start, c0) + dist(ln.end, c1);
    const swapped = dist(ln.start, c1) + dist(ln.end, c0);
    const [sc, ec] = direct <= swapped ? [c0, c1] : [c1, c0];
    if (dist(ln.start, sc) < SNAP_TOL) snapStart = sc;
    if (dist(ln.end, ec) < SNAP_TOL) snapEnd = ec;
  } else {
    // One referenced node — snap only the nearer endpoint (never both, or a
    // short curve would collapse to a point).
    const c = cands[0];
    const ds = dist(ln.start, c);
    const de = dist(ln.end, c);
    if (ds <= de) { if (ds < SNAP_TOL) snapStart = c; }
    else if (de < SNAP_TOL) snapEnd = c;
  }
  if (!snapStart && !snapEnd) return ln;
  const clone: T = { ...ln };
  if (snapStart) clone.start = { x: snapStart.x, y: snapStart.y };
  if (snapEnd) clone.end = { x: snapEnd.x, y: snapEnd.y };
  return clone;
}
