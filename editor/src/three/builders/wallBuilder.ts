import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import type { SurfacePrimitive, ParametricOpening } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';
import { tessellateArc, pointOnArc, nearestPointOnArc, arcLength } from '../../utils/arcMath.ts';

const DEFAULT_WALL_HEIGHT = 3.0;

/**
 * Build a SurfacePrimitive for a wall / structure_wall element.
 * The footprint is a 4-corner quad computed from start/end + halfWidth (before miter adjustment).
 * The miter resolver later rewrites these corners based on junction analysis.
 */
export function buildWallPrimitive(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
  allElements: Map<string, CanonicalElement> | undefined,
  wallsOnLevel: LineElement[],
): SurfacePrimitive | null {
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;
  const el = element as LineElement;

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const halfWidth = el.strokeWidth / 2;
  const { height, baseOffset } = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_WALL_HEIGHT);
  const baseY = levelElevation + baseOffset;

  let footprint: { x: number; y: number }[];

  if (el.arc) {
    // Arc wall: tessellate and compute offset polygon
    const pts = tessellateArc(el.start, el.end, el.arc, 0.2);
    const n = pts.length;
    const leftSide: { x: number; y: number }[] = [];
    const rightSide: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const { tangent } = pointOnArc(el.start, el.end, el.arc, t);
      const nx = -tangent.y, ny = tangent.x;
      leftSide.push({ x: pts[i].x + nx * halfWidth, y: pts[i].y + ny * halfWidth });
      rightSide.push({ x: pts[i].x - nx * halfWidth, y: pts[i].y - ny * halfWidth });
    }
    footprint = [...leftSide, ...rightSide.reverse()];
  } else {
    const nx = -dy / len;
    const ny = dx / len;
    footprint = [
      { x: el.start.x + nx * halfWidth, y: el.start.y + ny * halfWidth },
      { x: el.end.x + nx * halfWidth, y: el.end.y + ny * halfWidth },
      { x: el.end.x - nx * halfWidth, y: el.end.y - ny * halfWidth },
      { x: el.start.x - nx * halfWidth, y: el.start.y - ny * halfWidth },
    ];
  }

  const openings = collectParametricOpenings(el, allElements, wallsOnLevel);
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  return {
    kind: 'surface',
    id: `surface:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    footprint,
    extrudeDirection: { x: 0, y: 1, z: 0 },
    height,
    origin: { x: 0, y: baseY, z: 0 },
    material,
    miterGroup: el.arc ? undefined : el.tableName,
    miterMeta: {
      startX: el.start.x, startY: el.start.y,
      endX: el.end.x, endY: el.end.y,
      halfWidth,
      arc: el.arc,
    },
    openings: openings.length > 0 ? openings : undefined,
  };
}

/**
 * Collect hosted door/window/opening elements for this wall.
 * Matches by host_id (handling prefixed IDs) with spatial-proximity fallback.
 */
function collectParametricOpenings(
  wall: LineElement,
  allElements: Map<string, CanonicalElement> | undefined,
  wallsOnLevel: LineElement[],
): ParametricOpening[] {
  if (!allElements) return [];

  // Un-prefixed id for CSV host_id matching
  const colonIdx = wall.id.indexOf(':');
  const unprefixedId = colonIdx >= 0 ? wall.id.substring(colonIdx + 1) : wall.id;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return [];
  const isArc = !!wall.arc;
  const ux = dx / len, uy = dy / len;

  const result: ParametricOpening[] = [];
  for (const el of allElements.values()) {
    if (el.tableName !== 'door' && el.tableName !== 'window' && el.tableName !== 'opening') continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    const hosted = el as LineElement;

    // Host_id matching (both full and un-prefixed)
    const hostId = hosted.attrs.host_id || hosted.hostId;
    let matched = false;
    if (hostId) {
      if (hostId === wall.id || hostId === unprefixedId) matched = true;
    }

    // Fallback: spatial proximity (only if no host_id given on any wall)
    if (!matched && !hostId) {
      const hc = midpoint(hosted.start, hosted.end);
      const d = pointToSegDist(hc.x, hc.y, wall.start.x, wall.start.y, wall.end.x, wall.end.y);
      if (d > wall.strokeWidth) continue;
      // Must be the CLOSEST wall (avoid duplicating across all walls)
      let closest = wall.id;
      let closestDist = d;
      for (const w of wallsOnLevel) {
        if (w.id === wall.id) continue;
        const d2 = pointToSegDist(hc.x, hc.y, w.start.x, w.start.y, w.end.x, w.end.y);
        if (d2 < closestDist) { closestDist = d2; closest = w.id; }
      }
      if (closest !== wall.id) continue;
      matched = true;
    }

    if (!matched) continue;

    // Compute position along wall (distance from wall.start to opening start, projected on wall dir)
    const hostedStart = hosted.start;
    const hostedEnd = hosted.end;
    let tMin: number;
    let width: number;
    if (isArc) {
      const wallLen = arcLength(wall.start, wall.end, wall.arc!);
      const hc = midpoint(hosted.start, hosted.end);
      const { t: tParam } = nearestPointOnArc(hc, wall.start, wall.end, wall.arc!);
      const center = tParam * wallLen;
      width = parseFloat(hosted.attrs.width) || 0.9;
      tMin = center - width / 2;
    } else {
      const tStart = ((hostedStart.x - wall.start.x) * ux + (hostedStart.y - wall.start.y) * uy);
      const tEnd = ((hostedEnd.x - wall.start.x) * ux + (hostedEnd.y - wall.start.y) * uy);
      tMin = Math.min(tStart, tEnd);
      const spanLen = Math.abs(tEnd - tStart);
      width = spanLen > 0.001 ? spanLen : (parseFloat(hosted.attrs.width) || 0.9);
    }
    const height = parseFloat(hosted.attrs.height) || (hosted.tableName === 'window' ? 1.2 : 2.1);
    const sillHeight = parseFloat(hosted.attrs.base_offset) || 0;
    const shape = (hosted.attrs.shape || 'rect') as 'rect' | 'round' | 'arch';

    result.push({
      kind: 'parametric',
      id: el.id,
      shape,
      position: tMin,
      width,
      height,
      sillHeight,
    });
  }

  return result;
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pointToSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}
