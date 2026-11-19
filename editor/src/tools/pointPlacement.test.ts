import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import type { PointElement } from '../model/elements.ts';
import { nearGeometry } from './drawPointTool.ts';
import { pickOrder } from '../utils/pickOrder.ts';
import { computeSnap } from '../utils/snap.ts';

const points = (h: ReturnType<typeof createHarness>, table: string) =>
  [...h.state.document!.elements.values()].filter(e => e.tableName === table) as PointElement[];

describe('point placement', () => {
  it('typed X, Tab, Y, Enter places at those coordinates', () => {
    const h = createHarness();
    h.pick('column');
    for (const k of ['2', '0', '.', '8', '5', 'Tab', '-', '1', '.', '7', '5']) expect(h.key(k)).toBe(true);
    expect(h.state.drawingState?.typed).toMatchObject({ length: '20.85', angle: '-1.75' });
    h.key('Enter');
    expect(points(h, 'column').map(c => c.position)).toEqual([{ x: 20.85, y: -1.75 }]);
    expect(h.state.drawingState?.typed).toBeUndefined();
    // A sign can start a value; letters are left to the shortcuts
    expect(h.key('-')).toBe(true);
    h.key('Escape');
    expect(h.key('w')).toBe(false);
  });

  it('near geometry, a point placement does not round to grid distances', () => {
    const h = createHarness();
    h.pick('column'); h.click(10, 10); h.done();
    const els = h.state.document!.elements;
    expect(nearGeometry(els.values(), { x: 10.75, y: 10.75 }, 2)).toBe(true);
    expect(nearGeometry(els.values(), { x: 20, y: 20 }, 2)).toBe(false);

    // The round-distance snap itself: 10.99 m off a grid rounds to 11 at this zoom unless off
    const grids = [{ id: 'gr-1', number: '1', x1: 0, y1: -5, x2: 0, y2: 30 }];
    const on = computeSnap({ x: 10.99, y: 3 }, 0.01, new Map(), undefined, undefined, undefined, grids, undefined, undefined, 'm', new Set(['gridline', 'angle', 'length']));
    expect(on.point.x).toBeCloseTo(11);
    const off = computeSnap({ x: 10.99, y: 3 }, 0.01, new Map(), undefined, undefined, undefined, grids, undefined, undefined, 'm', new Set(['gridline', 'angle', 'length', 'grid']));
    expect(off.point.x).toBeCloseTo(10.99);
  });
});

describe('pick order', () => {
  it('draws points over areas within a layer (a pile in its cap is clickable)', () => {
    const cap = { id: 'f-1', geometry: 'polygon' };
    const pile = { id: 'f-2', geometry: 'point' };
    const strip = { id: 'f-3', geometry: 'line' };
    expect(pickOrder([pile, cap, strip]).map(e => e.id)).toEqual(['f-1', 'f-3', 'f-2']);
    const same = [cap, { id: 'f-4', geometry: 'polygon' }];
    expect(pickOrder(same)).toBe(same);
  });
});
