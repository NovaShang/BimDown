/**
 * Uniform grid over axis-aligned boxes, for "which boxes may overlap this
 * one" queries. Results are box indices in ascending order, a superset of the
 * true overlaps, so callers keep their exact test and their original
 * iteration order (results stay identical to a full scan).
 */
export interface Box2 { minX: number; minY: number; maxX: number; maxY: number }

/** Boxes spanning more cells than this (or not finite) are returned by every query. */
const MAX_CELLS_PER_BOX = 1024;

export class AabbGrid {
  private minX = 0;
  private minY = 0;
  private cell = 1;
  private cols = 1;
  private rows = 1;
  private cells = new Map<number, number[]>();
  private big: number[] = [];
  private stamp: Int32Array;
  private stampValue = 0;
  private count: number;

  constructor(boxes: readonly Box2[]) {
    this.count = boxes.length;
    this.stamp = new Int32Array(boxes.length);
    if (boxes.length === 0) return;
    const finite = (b: Box2) => Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sum = 0, n = 0;
    for (const b of boxes) {
      if (!finite(b)) continue;
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      sum += Math.max(b.maxX - b.minX, b.maxY - b.minY);
      n++;
    }
    if (n === 0) {
      for (let i = 0; i < boxes.length; i++) this.big.push(i);
      return;
    }
    const w = maxX - minX, h = maxY - minY;
    // About one box per cell, at most ~1M cells.
    this.cell = Math.max(sum / n, Math.sqrt((w * h) / 1e6), 1e-6);
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.floor(w / this.cell) + 1;
    this.rows = Math.floor(h / this.cell) + 1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      // Non-finite boxes can't be placed: return them from every query.
      if (!finite(b)) { this.big.push(i); continue; }
      const c0 = this.col(b.minX), c1 = this.col(b.maxX), r0 = this.row(b.minY), r1 = this.row(b.maxY);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_BOX) { this.big.push(i); continue; }
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * this.cols + c;
          const list = this.cells.get(key);
          if (list) list.push(i); else this.cells.set(key, [i]);
        }
      }
    }
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
  }

  /** Indices of boxes that may overlap `q` (inclusive bounds), ascending. */
  query(q: Box2): number[] {
    const stamp = ++this.stampValue;
    const out: number[] = [];
    const add = (i: number) => {
      if (this.stamp[i] === stamp) return;
      this.stamp[i] = stamp;
      out.push(i);
    };
    const c0 = this.col(q.minX), c1 = this.col(q.maxX), r0 = this.row(q.minY), r1 = this.row(q.maxY);
    if (!((c1 - c0 + 1) * (r1 - r0 + 1) <= MAX_CELLS_PER_BOX)) {
      for (let i = 0; i < this.count; i++) out.push(i);
      return out;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(r * this.cols + c);
        if (list) for (const i of list) add(i);
      }
    }
    for (const i of this.big) add(i);
    return out.sort((a, b) => a - b);
  }
}
