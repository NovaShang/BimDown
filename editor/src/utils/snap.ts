import type { CanonicalElement, Point } from '../model/elements.ts';

// ── Snap types ──

export type SnapType = 'endpoint' | 'center' | 'edge' | 'midpoint' | 'angle' | 'length' | 'grid';

export type SnapGuideType = 'point' | 'vline' | 'hline' | 'edge_segment' | 'angle_line' | 'length_ring';

export interface SnapGuide {
  type: SnapGuideType;
  x: number;
  y: number;
  snapType?: SnapType;
  /** For edge_segment / angle_line: second endpoint */
  x2?: number;
  y2?: number;
  label?: string;
}

export interface SnapResult {
  point: Point;
  snapX: { type: SnapType; value: number } | null;
  snapY: { type: SnapType; value: number } | null;
  guides: SnapGuide[];
  /** The highest-priority snap type that contributed to the result */
  dominantType?: SnapType;
}

// ── Grid spacing ──

const GRID_LEVELS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100,
];
const GRID_TARGET_PX = 50;
const SNAP_THRESHOLD_PX = 10;

export function adaptiveGridSpacing(pixelSize: number): number {
  const target = pixelSize * GRID_TARGET_PX;
  let best = GRID_LEVELS[0];
  let bestDist = Infinity;
  for (const g of GRID_LEVELS) {
    const dist = Math.abs(g - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = g;
    }
  }
  return best;
}

// ── Formatting ──

function formatLength(meters: number): string {
  if (meters < 0.01) return `${(meters * 1000).toFixed(1)} mm`;
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

// ── Geometry utilities ──

function nearestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function perpendicularOffset(a: Point, b: Point, dist: number): { dx: number; dy: number } {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.sqrt(ex * ex + ey * ey);
  if (len === 0) return { dx: 0, dy: 0 };
  return { dx: (-ey / len) * dist, dy: (ex / len) * dist };
}

function dist2D(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Snap targets ──

interface SnapTarget {
  x: number;
  y: number;
  type: SnapType;
  priority: number; // 1 = highest
  edgeFrom?: Point;
  edgeTo?: Point;
}

function extractSnapTargets(
  elements: ReadonlyMap<string, CanonicalElement>,
  excludeIds: Set<string>,
  cursor: Point,
): SnapTarget[] {
  const targets: SnapTarget[] = [];

  for (const [id, el] of elements) {
    if (excludeIds.has(id)) continue;

    if (el.geometry === 'line') {
      // Priority 1: centerline endpoints
      targets.push({ x: el.start.x, y: el.start.y, type: 'endpoint', priority: 1 });
      targets.push({ x: el.end.x, y: el.end.y, type: 'endpoint', priority: 1 });

      // Priority 2: outer edges (offset by strokeWidth/2)
      const hw = el.strokeWidth / 2;
      if (hw > 0) {
        const off = perpendicularOffset(el.start, el.end, hw);
        // 4 corners of the wall rectangle
        const c0: Point = { x: el.start.x + off.dx, y: el.start.y + off.dy };
        const c1: Point = { x: el.end.x + off.dx, y: el.end.y + off.dy };
        const c2: Point = { x: el.end.x - off.dx, y: el.end.y - off.dy };
        const c3: Point = { x: el.start.x - off.dx, y: el.start.y - off.dy };
        // Project cursor onto each of the 4 edge segments
        const edges: [Point, Point][] = [[c0, c1], [c1, c2], [c2, c3], [c3, c0]];
        for (const [a, b] of edges) {
          const np = nearestPointOnSegment(cursor, a, b);
          targets.push({
            x: np.x, y: np.y, type: 'edge', priority: 2,
            edgeFrom: a, edgeTo: b,
          });
        }
      }

      // Priority 3: centerline midpoint
      targets.push({
        x: (el.start.x + el.end.x) / 2,
        y: (el.start.y + el.end.y) / 2,
        type: 'midpoint', priority: 3,
      });
    } else if (el.geometry === 'point') {
      // Priority 1: center (location point)
      targets.push({ x: el.position.x, y: el.position.y, type: 'center', priority: 1 });

      // Priority 2: bounding box edges
      const cx = el.position.x;
      const cy = el.position.y;
      const hw = el.width / 2;
      const hh = el.height / 2;
      const corners: Point[] = [
        { x: cx - hw, y: cy - hh }, // top-left
        { x: cx + hw, y: cy - hh }, // top-right
        { x: cx + hw, y: cy + hh }, // bottom-right
        { x: cx - hw, y: cy + hh }, // bottom-left
      ];
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const np = nearestPointOnSegment(cursor, a, b);
        targets.push({
          x: np.x, y: np.y, type: 'edge', priority: 2,
          edgeFrom: a, edgeTo: b,
        });
      }
    } else if (el.geometry === 'polygon') {
      const verts = el.vertices;

      // Priority 1: vertices
      for (const v of verts) {
        targets.push({ x: v.x, y: v.y, type: 'endpoint', priority: 1 });
      }

      // Priority 2: edge segments (nearest point projection)
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const np = nearestPointOnSegment(cursor, a, b);
        targets.push({
          x: np.x, y: np.y, type: 'edge', priority: 2,
          edgeFrom: a, edgeTo: b,
        });
      }

      // Priority 3: edge midpoints
      for (let i = 0; i < verts.length; i++) {
        const next = verts[(i + 1) % verts.length];
        targets.push({
          x: (verts[i].x + next.x) / 2,
          y: (verts[i].y + next.y) / 2,
          type: 'midpoint', priority: 3,
        });
      }
    }
  }

  return targets;
}

// ── Angle constraint ──

const DEG_TO_RAD = Math.PI / 180;

function computeAngleSnap(
  input: Point,
  anchor: Point,
  threshold: number,
  angleIncrement: number,
): { point: Point; angleDeg: number; distance: number } | null {
  const dx = input.x - anchor.x;
  const dy = input.y - anchor.y;
  const rawLen = Math.sqrt(dx * dx + dy * dy);
  if (rawLen < 1e-9) return null;

  const rawAngle = Math.atan2(dy, dx);
  const incRad = angleIncrement * DEG_TO_RAD;
  const snappedAngle = Math.round(rawAngle / incRad) * incRad;

  // Project input onto the snapped-angle ray from anchor
  const projLen = dx * Math.cos(snappedAngle) + dy * Math.sin(snappedAngle);
  const projected: Point = {
    x: anchor.x + projLen * Math.cos(snappedAngle),
    y: anchor.y + projLen * Math.sin(snappedAngle),
  };

  const perpDist = dist2D(input, projected);
  if (perpDist >= threshold) return null;

  // Normalize angle to 0..360
  let angleDeg = (snappedAngle / DEG_TO_RAD) % 360;
  if (angleDeg < 0) angleDeg += 360;

  return { point: projected, angleDeg, distance: perpDist };
}

// ── Main snap function ──

export function computeSnap(
  input: Point,
  pixelSize: number,
  elements: ReadonlyMap<string, CanonicalElement> | null,
  excludeIds: Set<string> = new Set(),
  anchor?: Point,
  angleIncrement: number = 45,
): SnapResult {
  const threshold = pixelSize * SNAP_THRESHOLD_PX;
  const guides: SnapGuide[] = [];

  let snapX: { type: SnapType; value: number; priority: number } | null = null;
  let snapY: { type: SnapType; value: number; priority: number } | null = null;
  let bestDx = threshold;
  let bestDy = threshold;

  // Track edge snap separately (needs 2D coherent snap)
  let bestEdge: { target: SnapTarget; dist: number } | null = null;

  const targets = elements ? extractSnapTargets(elements, excludeIds, input) : [];

  // ── Pass 1: Point-like targets (endpoint, center, midpoint) — independent X/Y ──
  // Proximity limit: only align axes when the perpendicular distance is reasonable.
  // For direct snap (both axes close), use full threshold.
  // For axis-only alignment, require the other axis within ALIGN_PERP_FACTOR * threshold.
  const ALIGN_PERP_FACTOR = 50; // ~500px perpendicular range at default zoom
  const alignPerpLimit = threshold * ALIGN_PERP_FACTOR;

  for (const t of targets) {
    if (t.type === 'edge') continue; // handled in pass 2

    const dx = Math.abs(input.x - t.x);
    const dy = Math.abs(input.y - t.y);

    if (dx < threshold && dy < alignPerpLimit) {
      if (!snapX || t.priority < snapX.priority || (t.priority === snapX.priority && dx < bestDx)) {
        bestDx = dx;
        snapX = { type: t.type, value: t.x, priority: t.priority };
      }
    }
    if (dy < threshold && dx < alignPerpLimit) {
      if (!snapY || t.priority < snapY.priority || (t.priority === snapY.priority && dy < bestDy)) {
        bestDy = dy;
        snapY = { type: t.type, value: t.y, priority: t.priority };
      }
    }
  }

  // ── Pass 2: Edge targets — 2D distance, coherent X+Y ──
  for (const t of targets) {
    if (t.type !== 'edge') continue;
    const d = dist2D(input, { x: t.x, y: t.y });
    if (d >= threshold) continue;

    const currentBestPriority = Math.min(snapX?.priority ?? Infinity, snapY?.priority ?? Infinity);
    if (t.priority <= currentBestPriority || (!snapX && !snapY)) {
      if (!bestEdge || d < bestEdge.dist) {
        bestEdge = { target: t, dist: d };
      }
    }
  }

  // Apply edge snap if it's the best option
  if (bestEdge) {
    const t = bestEdge.target;
    const currentBestPriority = Math.min(snapX?.priority ?? Infinity, snapY?.priority ?? Infinity);
    if (t.priority <= currentBestPriority || (!snapX && !snapY)) {
      snapX = { type: 'edge', value: t.x, priority: t.priority };
      snapY = { type: 'edge', value: t.y, priority: t.priority };
      // Add edge segment guide
      if (t.edgeFrom && t.edgeTo) {
        guides.push({
          type: 'edge_segment',
          x: t.edgeFrom.x, y: t.edgeFrom.y,
          x2: t.edgeTo.x, y2: t.edgeTo.y,
          snapType: 'edge',
        });
      }
    }
  }

  // ── Pass 3: Angle constraint ──
  let angleResult: ReturnType<typeof computeAngleSnap> = null;
  if (anchor) {
    // Use the current (possibly snapped) point as basis, but apply angle to raw input
    angleResult = computeAngleSnap(input, anchor, threshold, angleIncrement);
    if (angleResult) {
      const currentBestPriority = Math.min(snapX?.priority ?? Infinity, snapY?.priority ?? Infinity);
      const anglePriority = 3.5;
      if (anglePriority <= currentBestPriority || (!snapX && !snapY)) {
        snapX = { type: 'angle', value: angleResult.point.x, priority: anglePriority };
        snapY = { type: 'angle', value: angleResult.point.y, priority: anglePriority };
      }

      // Always show the angle guide line when within threshold (even if overridden by higher-priority snap)
      const extent = 500 * pixelSize; // extend the line far enough
      const rad = angleResult.angleDeg * DEG_TO_RAD;
      guides.push({
        type: 'angle_line',
        x: anchor.x, y: anchor.y,
        x2: anchor.x + Math.cos(rad) * extent,
        y2: anchor.y + Math.sin(rad) * extent,
        snapType: 'angle',
        label: `${Math.round(angleResult.angleDeg)}°`,
      });
    }
  }

  // ── Pass 4: Grid fallback ──
  const gridSpacing = adaptiveGridSpacing(pixelSize);
  const gridThreshold = gridSpacing * 0.45;

  if (!snapX) {
    const gridX = Math.round(input.x / gridSpacing) * gridSpacing;
    if (Math.abs(input.x - gridX) < Math.min(gridThreshold, threshold)) {
      snapX = { type: 'grid', value: gridX, priority: 4 };
    }
  }
  if (!snapY) {
    const gridY = Math.round(input.y / gridSpacing) * gridSpacing;
    if (Math.abs(input.y - gridY) < Math.min(gridThreshold, threshold)) {
      snapY = { type: 'grid', value: gridY, priority: 4 };
    }
  }

  // ── Pass 5: Length snap (adjust distance from anchor to round values) ──
  if (anchor) {
    const preX = snapX ? snapX.value : input.x;
    const preY = snapY ? snapY.value : input.y;
    const adx = preX - anchor.x;
    const ady = preY - anchor.y;
    const rawLen = Math.sqrt(adx * adx + ady * ady);

    if (rawLen > 1e-9) {
      const gridSpacingLen = adaptiveGridSpacing(pixelSize);
      const snappedLen = Math.round(rawLen / gridSpacingLen) * gridSpacingLen;
      const lenDiff = Math.abs(rawLen - snappedLen);
      const lenThreshold = gridSpacingLen * 0.3;

      if (snappedLen > 0 && lenDiff < lenThreshold && lenDiff < threshold) {
        const scale = snappedLen / rawLen;
        const newX = anchor.x + adx * scale;
        const newY = anchor.y + ady * scale;
        snapX = { type: snapX?.type ?? 'length', value: newX, priority: snapX?.priority ?? 3.5 };
        snapY = { type: snapY?.type ?? 'length', value: newY, priority: snapY?.priority ?? 3.5 };

        // Add length ring guide (circle at snapped radius)
        guides.push({
          type: 'length_ring',
          x: anchor.x, y: anchor.y,
          x2: snappedLen, // abuse x2 to carry radius
          snapType: 'length',
          label: formatLength(snappedLen),
        });
      }
    }
  }

  // ── Build guides ──
  const finalX = snapX ? snapX.value : input.x;
  const finalY = snapY ? snapY.value : input.y;
  const dominantType = snapX && snapY
    ? (snapX.priority <= snapY.priority ? snapX.type : snapY.type)
    : (snapX?.type ?? snapY?.type);

  // Axis alignment guides (only for point-like object snaps)
  const noAxisGuide = new Set<SnapType>(['grid', 'edge', 'angle', 'length']);
  if (snapX && !noAxisGuide.has(snapX.type)) {
    guides.push({ type: 'vline', x: snapX.value, y: input.y, snapType: snapX.type });
  }
  if (snapY && !noAxisGuide.has(snapY.type)) {
    guides.push({ type: 'hline', x: input.x, y: snapY.value, snapType: snapY.type });
  }

  // Snap point marker
  if (snapX || snapY) {
    const pointSnapType = dominantType ?? 'grid';
    // Don't add a duplicate point guide for grid-only snaps
    if (pointSnapType !== 'grid') {
      guides.push({ type: 'point', x: finalX, y: finalY, snapType: pointSnapType });
    }
  }

  // Grid snaps: no guide lines, just silently snap

  return {
    point: { x: finalX, y: finalY },
    snapX: snapX ? { type: snapX.type, value: snapX.value } : null,
    snapY: snapY ? { type: snapY.type, value: snapY.value } : null,
    guides,
    dominantType,
  };
}

// ── Pixel size helper ──

export function computePixelSize(
  screenToSvg: (cx: number, cy: number) => { x: number; y: number } | null,
): number {
  const a = screenToSvg(0, 0);
  const b = screenToSvg(1, 0);
  if (!a || !b) return 0.01;
  return Math.abs(b.x - a.x) || 0.01;
}

const EMPTY_MAP = new Map<string, CanonicalElement>();

/** Convenience: snap a point using ToolContext-like info */
export function snapPoint(
  raw: Point,
  screenToSvg: (cx: number, cy: number) => { x: number; y: number } | null,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
  excludeIds?: Set<string>,
  anchor?: Point,
  angleIncrement?: number,
): SnapResult {
  const pixelSize = computePixelSize(screenToSvg);
  return computeSnap(raw, pixelSize, elements ?? EMPTY_MAP, excludeIds, anchor, angleIncrement);
}
