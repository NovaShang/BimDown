import type { CanonicalElement, Point } from '../model/elements.ts';

// ── Snap types ──

export type SnapType = 'grid' | 'center' | 'endpoint' | 'midpoint' | 'edge';

export interface SnapGuide {
  type: 'point' | 'vline' | 'hline';
  x: number;
  y: number;
  label?: string;
}

export interface SnapResult {
  point: Point;
  snapX: { type: SnapType; value: number } | null;
  snapY: { type: SnapType; value: number } | null;
  guides: SnapGuide[];
}

// ── Grid spacing ──

/** Nice round grid spacings (meters). We pick the one whose screen size falls in the sweet spot. */
const GRID_LEVELS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100,
];

/** Target screen-pixel size for grid cells (~30-80px feels right) */
const GRID_TARGET_PX = 50;

/** Snap threshold in screen pixels */
const SNAP_THRESHOLD_PX = 10;

/**
 * Choose an adaptive grid spacing given the current pixel size (SVG units per screen pixel).
 */
export function adaptiveGridSpacing(pixelSize: number): number {
  // We want gridSpacing / pixelSize ~= GRID_TARGET_PX
  const target = pixelSize * GRID_TARGET_PX;
  // Find the closest GRID_LEVEL
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

// ── Snap target extraction ──

interface SnapTarget {
  x: number;
  y: number;
  type: SnapType;
}

function extractSnapTargets(
  elements: ReadonlyMap<string, CanonicalElement>,
  excludeIds: Set<string>,
): SnapTarget[] {
  const targets: SnapTarget[] = [];

  for (const [id, el] of elements) {
    if (excludeIds.has(id)) continue;

    if (el.geometry === 'line') {
      targets.push({ x: el.start.x, y: el.start.y, type: 'endpoint' });
      targets.push({ x: el.end.x, y: el.end.y, type: 'endpoint' });
      targets.push({
        x: (el.start.x + el.end.x) / 2,
        y: (el.start.y + el.end.y) / 2,
        type: 'midpoint',
      });
    } else if (el.geometry === 'point') {
      const cx = el.position.x;
      const cy = el.position.y;
      const hw = el.width / 2;
      const hh = el.height / 2;
      // Center
      targets.push({ x: cx, y: cy, type: 'center' });
      // Edge midpoints
      targets.push({ x: cx - hw, y: cy, type: 'edge' });
      targets.push({ x: cx + hw, y: cy, type: 'edge' });
      targets.push({ x: cx, y: cy - hh, type: 'edge' });
      targets.push({ x: cx, y: cy + hh, type: 'edge' });
      // Corners
      targets.push({ x: cx - hw, y: cy - hh, type: 'endpoint' });
      targets.push({ x: cx + hw, y: cy - hh, type: 'endpoint' });
      targets.push({ x: cx + hw, y: cy + hh, type: 'endpoint' });
      targets.push({ x: cx - hw, y: cy + hh, type: 'endpoint' });
    } else if (el.geometry === 'polygon') {
      const verts = el.vertices;
      for (let i = 0; i < verts.length; i++) {
        targets.push({ x: verts[i].x, y: verts[i].y, type: 'endpoint' });
        const next = verts[(i + 1) % verts.length];
        targets.push({
          x: (verts[i].x + next.x) / 2,
          y: (verts[i].y + next.y) / 2,
          type: 'midpoint',
        });
      }
      // Centroid
      if (verts.length >= 3) {
        const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length;
        const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length;
        targets.push({ x: cx, y: cy, type: 'center' });
      }
    }
  }

  return targets;
}

// ── Main snap function ──

/**
 * Compute the best snap for a given input point.
 *
 * @param input       - Raw (unsnapped) point in SVG coords
 * @param pixelSize   - SVG units per screen pixel (for threshold/grid)
 * @param elements    - All document elements
 * @param excludeIds  - Elements to exclude (e.g. being dragged)
 * @returns SnapResult or null if no snap
 */
export function computeSnap(
  input: Point,
  pixelSize: number,
  elements: ReadonlyMap<string, CanonicalElement> | null,
  excludeIds: Set<string> = new Set(),
): SnapResult {
  const threshold = pixelSize * SNAP_THRESHOLD_PX;
  const guides: SnapGuide[] = [];

  let snapX: { type: SnapType; value: number } | null = null;
  let snapY: { type: SnapType; value: number } | null = null;
  let bestDx = threshold;
  let bestDy = threshold;

  // ── Object snapping (higher priority) ──
  if (elements) {
    const targets = extractSnapTargets(elements, excludeIds);

    for (const t of targets) {
      const dx = Math.abs(input.x - t.x);
      const dy = Math.abs(input.y - t.y);

      if (dx < bestDx) {
        bestDx = dx;
        snapX = { type: t.type, value: t.x };
      }
      if (dy < bestDy) {
        bestDy = dy;
        snapY = { type: t.type, value: t.y };
      }
    }
  }

  // ── Grid snapping (fallback for axes not yet snapped) ──
  const gridSpacing = adaptiveGridSpacing(pixelSize);
  const gridThreshold = gridSpacing * 0.45; // snap within 45% of grid cell

  if (!snapX) {
    const gridX = Math.round(input.x / gridSpacing) * gridSpacing;
    if (Math.abs(input.x - gridX) < Math.min(gridThreshold, threshold)) {
      snapX = { type: 'grid', value: gridX };
    }
  }
  if (!snapY) {
    const gridY = Math.round(input.y / gridSpacing) * gridSpacing;
    if (Math.abs(input.y - gridY) < Math.min(gridThreshold, threshold)) {
      snapY = { type: 'grid', value: gridY };
    }
  }

  // ── Build guides ──
  if (snapX && snapX.type !== 'grid') {
    guides.push({ type: 'vline', x: snapX.value, y: input.y });
  }
  if (snapY && snapY.type !== 'grid') {
    guides.push({ type: 'hline', x: input.x, y: snapY.value });
  }
  if (snapX && snapY && snapX.type !== 'grid' && snapY.type !== 'grid') {
    guides.push({ type: 'point', x: snapX.value, y: snapY.value });
  }
  if (snapX && snapX.type === 'grid') {
    guides.push({ type: 'vline', x: snapX.value, y: input.y, label: 'grid' });
  }
  if (snapY && snapY.type === 'grid') {
    guides.push({ type: 'hline', x: input.x, y: snapY.value, label: 'grid' });
  }

  return {
    point: {
      x: snapX ? snapX.value : input.x,
      y: snapY ? snapY.value : input.y,
    },
    snapX,
    snapY,
    guides,
  };
}

// ── Pixel size helper ──

/**
 * Compute SVG units per screen pixel from the screenToSvg function.
 * Call with two points 1 pixel apart.
 */
export function computePixelSize(
  screenToSvg: (cx: number, cy: number) => { x: number; y: number } | null,
): number {
  const a = screenToSvg(0, 0);
  const b = screenToSvg(1, 0);
  if (!a || !b) return 0.01; // fallback
  return Math.abs(b.x - a.x) || 0.01;
}

const EMPTY_MAP = new Map<string, CanonicalElement>();

/** Convenience: snap a point using ToolContext-like info */
export function snapPoint(
  raw: Point,
  screenToSvg: (cx: number, cy: number) => { x: number; y: number } | null,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
  excludeIds?: Set<string>,
): SnapResult {
  const pixelSize = computePixelSize(screenToSvg);
  return computeSnap(raw, pixelSize, elements ?? EMPTY_MAP, excludeIds);
}
