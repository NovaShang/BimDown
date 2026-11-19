import { describe, it, expect } from 'vitest';
import { orthoLock, orthoSnap } from './orthoLock.ts';
import { nextGridLabel, gridFromClicks } from './drawGridTool.ts';

const g = (...numbers: string[]) => numbers.map(number => ({ number }));

const names = (gs: { number: string }[]) => gs.map(x => x.number);

describe('datum line tools (sections, grids)', () => {
  it('locks to the nearest axis within a few degrees, or always with Shift, keeping the snapped length', () => {
    const a = { x: 9, y: -2.5 };
    // 0.05 off vertical over 16 m: locked, length from the snapped point
    expect(orthoLock(a, { x: 9.05, y: 13.5 }, { x: 4.6, y: 13.4999 }, false)).toEqual({ x: 9, y: 13.4999 });
    // 30° off: free unless Shift
    expect(orthoLock(a, { x: 17, y: 2.1 }, { x: 17, y: 2.1 }, false)).toBeNull();
    expect(orthoLock(a, { x: 17, y: 2.1 }, { x: 17, y: 2.1 }, true)).toEqual({ x: 17, y: -2.5 });
    const snap = orthoSnap(a, { x: 9.2, y: 10 }, { point: { x: 9.3, y: 10 }, snapX: { type: 'endpoint', value: 9.3 }, snapY: { type: 'endpoint', value: 10 }, guides: [] }, false);
    expect(snap.point).toEqual({ x: 9, y: 10 });
    expect(snap.snapX).toBeNull();
    expect(snap.snapY?.value).toBe(10);
  });

  it('names horizontal grids A, B, C… (no I / O) and vertical ones 1, 2, 3…', () => {
    expect(nextGridLabel([], 'letters')).toBe('A');
    expect(nextGridLabel([], 'numbers')).toBe('1');
    expect(nextGridLabel(names(g('1', '2', 'A')), 'letters')).toBe('B');
    expect(nextGridLabel(names(g('1', '2', 'A')), 'numbers')).toBe('3');
    expect(nextGridLabel(names(g('H')), 'letters')).toBe('J');
    expect(nextGridLabel(names(g('N')), 'letters')).toBe('P');
    expect(nextGridLabel(names(g('Z')), 'letters')).toBe('AA');
    expect(nextGridLabel(names(g('B', 'C1')), 'letters')).toBe('C');
  });

  it('puts the grid head at the second click', () => {
    expect(gridFromClicks({ x: 0, y: 0 }, { x: 20, y: 0 })).toEqual({ start: { x: 20, y: 0 }, end: { x: 0, y: 0 } });
  });
});
