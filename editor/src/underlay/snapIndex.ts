// Uniform-grid index over an underlay's segments (plan coordinates) so the
// snap engine can query DXF vertices and edges near the cursor in O(local).

import type { Point } from '../model/elements.ts';
import type { ExternalSnapTarget } from '../utils/snap.ts';

/** Segments touching more cells than this go to an always-checked list. */
const MAX_CELLS_PER_SEGMENT = 64;

export class SegmentIndex {
  /** x1, y1, x2, y2 per segment */
  private readonly segs: Float64Array;
  private readonly cell: number;
  private readonly cells = new Map<string, number[]>();
  private readonly long: number[] = [];
  readonly count: number;

  constructor(segments: Float64Array) {
    this.segs = segments;
    this.count = segments.length / 4;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < segments.length; i += 2) {
      minX = Math.min(minX, segments[i]); maxX = Math.max(maxX, segments[i]);
      minY = Math.min(minY, segments[i + 1]); maxY = Math.max(maxY, segments[i + 1]);
    }
    const area = Math.max((maxX - minX) * (maxY - minY), 1e-12);
    // ~4 segments per cell on average
    this.cell = Math.max(Math.sqrt((area * 4) / Math.max(this.count, 1)), 1e-6);
    for (let s = 0; s < this.count; s++) {
      const o = s * 4;
      const cx0 = Math.floor(Math.min(segments[o], segments[o + 2]) / this.cell);
      const cx1 = Math.floor(Math.max(segments[o], segments[o + 2]) / this.cell);
      const cy0 = Math.floor(Math.min(segments[o + 1], segments[o + 3]) / this.cell);
      const cy1 = Math.floor(Math.max(segments[o + 1], segments[o + 3]) / this.cell);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS_PER_SEGMENT) {
        this.long.push(s);
        continue;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = `${cx},${cy}`;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, list = []);
          list.push(s);
        }
      }
    }
  }

  /** Vertices, nearest edge points and midpoints within `radius` of `p`. */
  query(p: Point, radius: number, out: ExternalSnapTarget[] = []): ExternalSnapTarget[] {
    const seen = new Set<number>();
    const visit = (s: number) => {
      if (seen.has(s)) return;
      seen.add(s);
      const o = s * 4;
      const ax = this.segs[o], ay = this.segs[o + 1], bx = this.segs[o + 2], by = this.segs[o + 3];
      // Cheap reject on the segment's padded bbox
      if (p.x < Math.min(ax, bx) - radius || p.x > Math.max(ax, bx) + radius
        || p.y < Math.min(ay, by) - radius || p.y > Math.max(ay, by) + radius) return;
      if (Math.hypot(p.x - ax, p.y - ay) < radius) out.push({ x: ax, y: ay, type: 'endpoint' });
      if (Math.hypot(p.x - bx, p.y - by) < radius) out.push({ x: bx, y: by, type: 'endpoint' });
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
      const nx = ax + t * dx, ny = ay + t * dy;
      if (Math.hypot(p.x - nx, p.y - ny) < radius) {
        out.push({ x: nx, y: ny, type: 'edge', edgeFrom: { x: ax, y: ay }, edgeTo: { x: bx, y: by } });
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (Math.hypot(p.x - mx, p.y - my) < radius) out.push({ x: mx, y: my, type: 'midpoint' });
      }
    };
    const cx0 = Math.floor((p.x - radius) / this.cell), cx1 = Math.floor((p.x + radius) / this.cell);
    const cy0 = Math.floor((p.y - radius) / this.cell), cy1 = Math.floor((p.y + radius) / this.cell);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 4096) {
      // Zoomed far out: the radius spans most of the drawing — scan everything.
      for (let s = 0; s < this.count; s++) visit(s);
      return out;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = this.cells.get(`${cx},${cy}`);
        if (list) for (const s of list) visit(s);
      }
    }
    for (const s of this.long) visit(s);
    return out;
  }
}
