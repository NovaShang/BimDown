import { describe, expect, it } from 'vitest';
import { AabbGrid, type Box2 } from './aabbGrid.ts';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const overlaps = (a: Box2, b: Box2) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

describe('AabbGrid', () => {
  it('returns every overlapping box, ascending, for mixed sizes, points and touching edges', () => {
    const r = rng(7);
    const boxes: Box2[] = [];
    for (let i = 0; i < 600; i++) {
      const x = r() * 100, y = r() * 60;
      const big = i % 50 === 0;
      const w = big ? r() * 120 : r() * 5, h = big ? r() * 80 : r() * 0.3;
      boxes.push({ minX: x, minY: y, maxX: x + w, maxY: y + h });
    }
    boxes.push({ minX: 10, minY: 10, maxX: 10, maxY: 10 }); // a point
    const grid = new AabbGrid(boxes);
    const queries: Box2[] = [...boxes.slice(0, 200), { minX: -50, minY: -50, maxX: -40, maxY: -40 }, { minX: 10, minY: 10, maxX: 10, maxY: 10 }];
    for (let i = 0; i < 200; i++) {
      const x = r() * 120 - 10, y = r() * 80 - 10;
      queries.push({ minX: x, minY: y, maxX: x, maxY: y });
    }
    for (const q of queries) {
      const got = grid.query(q);
      expect([...got].sort((a, b) => a - b)).toEqual(got);
      const expected = boxes.map((b, i) => (overlaps(q, b) ? i : -1)).filter(i => i >= 0);
      const set = new Set(got);
      for (const i of expected) expect(set.has(i)).toBe(true);
    }
  });

  it('copes with empty and degenerate input', () => {
    expect(new AabbGrid([]).query({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toEqual([]);
    const nan = new AabbGrid([{ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, { minX: 0, minY: 0, maxX: 1, maxY: 1 }]);
    expect(nan.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toEqual([0, 1]);
  });
});
