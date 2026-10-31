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
