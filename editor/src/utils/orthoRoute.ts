/**
 * Orthogonal (Manhattan) routing for MEP pipes.
 *
 * Given two world-space endpoints (with optional outward port directions) we
 * synthesise a polyline that:
 *   - starts at A
 *   - ends at B
 *   - uses only horizontal and vertical segments (XY plane)
 *   - prefers the source port's outward direction for the first leg
 *
 * The polyline is then materialised into a set of straight pipe rows + one
 * passive `mep_node` row per intermediate bend (which the topology resolver
 * classifies as an elbow at render time). This keeps the "pipe is a straight
 * segment" invariant from the spec while still letting users lay out
 * multi-bend runs in a single gesture.
 */
import type { CanonicalElement, SpatialLineElement, PointElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

const EPS = 1e-4;

/** Pick a 1- or 2-segment orthogonal polyline from A to B.
 *  When the source direction is provided, the first leg leaves the source
 *  along that axis if it is axis-aligned. Returns the *interior* polyline —
 *  no offset / safety distance is applied. */
export function orthoRoute(
  a: Point,
  b: Point,
  opts: {
    /** Outward unit vector of the source port (host-local already rotated to
     *  world). When mostly horizontal we route H-first; mostly vertical → V-
     *  first. Falls back to "longer axis first" when not provided. */
    sourceDir?: { x: number; y: number };
    /** Outward unit vector of the target port (already in world). When set,
     *  the last leg approaches B along the negation of this vector. */
    targetDir?: { x: number; y: number };
  } = {},
): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Degenerate / single-axis cases first.
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return [a];
  if (Math.abs(dy) < EPS) return [a, b];
  if (Math.abs(dx) < EPS) return [a, b];

  // Decide which axis the first leg should follow.
  const sourceAxis = pickAxis(opts.sourceDir);
  const targetAxis = pickAxis(opts.targetDir);

  // If the source declares H, first leg is horizontal → corner at (B.x, A.y).
  // Mirror for vertical. If only target is declared, work backwards: the last
  // leg should match target's axis, so the corner picks the *other* axis from
  // A's side. If neither is declared, prefer the longer axis first.
  let firstAxis: 'h' | 'v';
  if (sourceAxis) firstAxis = sourceAxis;
  else if (targetAxis) firstAxis = targetAxis === 'h' ? 'v' : 'h';
  else firstAxis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';

  const corner: Point = firstAxis === 'h'
    ? { x: b.x, y: a.y }
    : { x: a.x, y: b.y };

  return [a, corner, b];
}

function pickAxis(dir: { x: number; y: number } | undefined): 'h' | 'v' | null {
  if (!dir) return null;
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  if (ax < EPS && ay < EPS) return null;
  return ax >= ay ? 'h' : 'v';
}

/** Materialisation parameters: pipe table to write to, system metadata, and
 *  port-ref endpoints. `from` / `to` may be null (open ends). */
export interface MaterialiseOpts {
  /** "pipe" | "duct" | "conduit" | "cable_tray". */
  tableName: string;
  /** Discipline string written on every emitted element. */
  discipline: string;
  /** Z elevation (start_z / end_z mirror) for every emitted segment. */
  z: number;
  /** Source / sink port refs ("host:port" or bare "host"); null for open. */
  fromRef: string | null;
  toRef: string | null;
  /** Cross-section attrs to copy onto every pipe row. */
  systemType: string;
  shape: string;
  sizeX: string;
  sizeY: string;
  /** Optional extra attrs to merge into every pipe row (e.g. base_offset). */
  extraAttrs?: Record<string, string>;
  /** Level id for default-attrs lookup. */
  levelId: string;
}

/** Convert a polyline into N pipe rows + (N-1) passive mep_node rows.
 *  Reserves new ids against `existingIds` (mutated). The first pipe's `from`
 *  is wired to `opts.fromRef`; the last pipe's `to` is wired to `opts.toRef`.
 *  Intermediate joints share an auto-allocated mep_node id; pipes reference
 *  it as bare host id (the spec convention for passive fittings). */
export function materialiseRoute(
  polyline: Point[],
  opts: MaterialiseOpts,
  existingIds: Set<string>,
): CanonicalElement[] {
  if (polyline.length < 2) return [];

  const out: CanonicalElement[] = [];
  const segments = polyline.length - 1;

  // Pre-allocate intermediate mep_node ids so each pipe knows its endpoint
  // refs before any rows are pushed.
  const jointIds: string[] = [];
  for (let i = 1; i < segments; i++) {
    const id = generateId('mep_node', existingIds);
    existingIds.add(id);
    jointIds.push(id);
  }

  const baseLineAttrs = defaultAttrs(opts.tableName, opts.levelId);
  const baseNodeAttrs = defaultAttrs('mep_node', opts.levelId);

  for (let i = 0; i < segments; i++) {
    const start = polyline[i];
    const end = polyline[i + 1];

    const pipeId = generateId(opts.tableName, existingIds);
    existingIds.add(pipeId);

    const fromRef = i === 0 ? opts.fromRef : jointIds[i - 1];
    const toRef = i === segments - 1 ? opts.toRef : jointIds[i];

    const attrs: Record<string, string> = {
      ...baseLineAttrs,
      ...(opts.extraAttrs ?? {}),
      id: pipeId,
      system_type: opts.systemType,
      shape: opts.shape,
      size_x: opts.sizeX,
      size_y: opts.sizeY,
      start_z: String(opts.z),
      end_z: String(opts.z),
    };
    if (fromRef) attrs.from = fromRef;
    if (toRef) attrs.to = toRef;

    const pipe: SpatialLineElement = {
      id: pipeId,
      tableName: opts.tableName,
      discipline: opts.discipline,
      geometry: 'spatial_line',
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      startZ: opts.z,
      endZ: opts.z,
      strokeWidth: parseFloat(opts.sizeX) || 0.05,
      attrs,
    };
    out.push(pipe);

    // After committing segment i, push the joint at polyline[i+1] when it is
    // an interior point.
    if (i < segments - 1) {
      const jointId = jointIds[i];
      const point = polyline[i + 1];
      const nodeAttrs: Record<string, string> = {
        ...baseNodeAttrs,
        id: jointId,
        system_type: opts.systemType,
        // kind stays empty — runtime derives elbow / tee / cross / etc. from
        // the connected-pipe geometry.
        kind: '',
      };
      const node: PointElement = {
        id: jointId,
        tableName: 'mep_node',
        discipline: opts.discipline,
        geometry: 'point',
        position: { x: point.x, y: point.y },
        width: 0,
        height: 0,
        attrs: nodeAttrs,
      };
      out.push(node);
    }
  }

  return out;
}
