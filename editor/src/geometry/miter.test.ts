import { describe, expect, it } from 'vitest';
import { computeCornerAdjustments, type WallSegment } from './miter.ts';

describe('T-junction corner adjustments', () => {
  it('ends the T-wall inside the main wall, short of its far face', () => {
    const walls: WallSegment[] = [
      // exterior wall along y = 0, 0.3 thick (faces at y = ±0.15)
      { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0, halfWidth: 0.15, fill: '#000' },
      // partition running north from the exterior wall's centre line
      { id: 'w-2', x1: 5, y1: 0, x2: 5, y2: 4, halfWidth: 0.06, fill: '#000' },
    ];
    const adj = computeCornerAdjustments(walls).adjustments.get('w-2:start');
    expect(adj).toBeDefined();
    for (const p of [adj!.left, adj!.right]) {
      // past the centre line (fills the joint) but not coplanar with the outer face
      expect(p.y).toBeLessThan(0);
      expect(p.y).toBeGreaterThan(-0.15);
      expect(p.y).toBeCloseTo(-0.15, 2);
    }
  });
});

describe('three walls at one point, two of them collinear', () => {
  it('squares the collinear pair so nothing is left uncovered under the stem', () => {
    const walls: WallSegment[] = [
      { id: 'w-1', x1: 4, y1: 0, x2: 10, y2: 0, halfWidth: 0.1, fill: '#000' },
      { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 8, halfWidth: 0.1, fill: '#000' },
      { id: 'w-3', x1: 14, y1: 0, x2: 10, y2: 0, halfWidth: 0.1, fill: '#000' },
    ];
    const adj = computeCornerAdjustments(walls).adjustments;
    const ends = (k: string) => [adj.get(k)!.left, adj.get(k)!.right].map(p => [+p.x.toFixed(3), +p.y.toFixed(3)]).sort((u, v) => u[0] - v[0] || u[1] - v[1]);
    expect(ends('w-1:end')).toEqual([[10, -0.1], [10, 0.1]]);
    expect(ends('w-3:end')).toEqual([[10, -0.1], [10, 0.1]]);
    // the stem stops on the near face of the pair
    expect(ends('w-2:start')).toEqual([[9.9, 0.1], [10.1, 0.1]]);
  });
});
