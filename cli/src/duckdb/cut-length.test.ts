import { describe, it, expect } from 'vitest';
import { sectionHalf, trimAtBeams, trimAtColumns } from './cut-length.js';

describe('cut length (mirrors the editor _framing.ts)', () => {
  it('stops at column faces (rect turned, round)', () => {
    const rect = { center: { x: 0, y: 0 }, rot: 0, ...sectionHalf('rect', 0.6, 0.5) };
    const round = { center: { x: 6, y: 0 }, rot: 0, ...sectionHalf('round', 0.8) };
    const [t0, t1] = trimAtColumns({ x: 0, y: 0 }, { x: 6, y: 0 }, [rect, round]);
    expect(t0 * 6).toBeCloseTo(0.3, 9);
    expect((1 - t1) * 6).toBeCloseTo(0.4, 9);
  });

  it('a secondary beam stops at the side faces of the girders it frames into; a beam at another height does not', () => {
    const girders = [
      { id: 'bm-1', start: { x: 0, y: 0 }, end: { x: 0, y: 8 }, hw: 0.15, z: 4, depth: 0.6 },
      { id: 'bm-2', start: { x: 6, y: 0 }, end: { x: 6, y: 8 }, hw: 0.15, z: 4, depth: 0.6 },
    ];
    const [t0, t1] = trimAtBeams('bm-3', { x: 0, y: 4 }, { x: 6, y: 4 }, 4, girders);
    expect(6 * (t1 - t0)).toBeCloseTo(5.7, 9);
    expect(trimAtBeams('bm-4', { x: 0, y: 4 }, { x: 6, y: 4 }, 1, girders)).toEqual([0, 1]);
  });
});
