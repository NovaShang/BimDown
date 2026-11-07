import { describe, it, expect } from 'vitest';
import { deriveRooms, type Segment } from './room-faces.js';

const seg = (id: string, x1: number, y1: number, x2: number, y2: number): Segment => ({ startX: x1, startY: y1, endX: x2, endY: y2, id });

describe('deriveRooms', () => {
  it('splits a long wall at a tee 5 cm from its end (tolerance is a distance, not a fraction)', () => {
    // 20 m wall along y=0; the partition meets it 5 cm from its start, which
    // is under 1% of its length and used to be treated as the endpoint.
    const segments = [
      seg('w-1', 0, 0, 20, 0),
      seg('w-2', 20, 0, 20, 4),
      seg('w-3', 20, 4, -2, 4),
      seg('w-4', -2, 4, -2, 0),
      seg('w-5', -2, 0, 0, 0),
      seg('w-6', 0.05, 0, 0.05, 4),
    ];
    const r = deriveRooms('lv-1', segments, [{ id: 'sp-1', x: 10, y: 2 }, { id: 'sp-2', x: -1, y: 2 }]);
    expect(r.roomIssues).toEqual([]);
    expect(Math.abs(r.matched.get('sp-1')!.signedArea)).toBeCloseTo(19.95 * 4, 3);
  });
});
