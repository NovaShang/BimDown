import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { fitInsert } from './insertFit.ts';
import type { LineElement } from '../model/elements.ts';

const inserts = (h: ReturnType<typeof createHarness>, table: string) =>
  [...h.state.document!.elements.values()].filter(e => e.tableName === table) as LineElement[];

describe('door / window placement without overlaps (B4)', () => {
  it('slides a partly overlapping insert to the free spot, refuses one on top of another', () => {
    const spans = [{ id: 'd-1', lo: 1.55, hi: 2.45, sill: 0, top: 2.1 }];
    expect(fitInsert(spans, 5, 0.9, 10, 0, 2.1, 0.005)).toEqual({ ok: true, position: 5, moved: false });
    expect(fitInsert(spans, 2.7, 0.9, 10, 0, 2.1, 0.005)).toEqual({ ok: true, position: expect.closeTo(2.9, 9), moved: true });
    expect(fitInsert(spans, 2, 0.9, 10, 0, 2.1, 0.005)).toEqual({ ok: false, blockedBy: 'd-1' });
    // A window above the door (sill 2.2) doesn't clash
    expect(fitInsert(spans, 2, 0.9, 10, 2.2, 0.6, 0.005)).toMatchObject({ ok: true, position: 2 });
    // Clamped to the wall
    expect(fitInsert([], 0.1, 0.9, 10, 0, 2.1, 0.005)).toMatchObject({ ok: true, position: 0.45 });
  });

  it('the door tool picks only the wall under the cursor and never stacks two doors', () => {
    const h = createHarness();
    h.pick('wall'); h.click(0, 0); h.click(10, 0); h.done();
    h.pick('door', { width: '0.9' });
    h.click(2, 0);
    expect(inserts(h, 'door')).toHaveLength(1);
    // 0.55 m off the wall centre (0.45 m past its face): out in the room, nothing placed
    h.click(2, 0.55);
    expect(inserts(h, 'door')).toHaveLength(1);
    // On the existing door: refused
    h.click(2.1, 0.05);
    expect(inserts(h, 'door')).toHaveLength(1);
    // Overlapping its edge: placed next to it
    h.click(2.7, 0);
    const doors = inserts(h, 'door');
    expect(doors).toHaveLength(2);
    expect(parseFloat(doors[1].attrs.position)).toBeCloseTo(2.9, 6);
    expect(doors[1].start.x).toBeCloseTo(2.45, 6);
    h.done();
  });

  it('an embedded curtain wall takes its stretch of the host wall', () => {
    const h = createHarness();
    h.pick('wall'); h.click(0, 0); h.click(10, 0); h.done();
    h.pick('curtain_wall'); h.click(5, 0); h.click(8, 0); h.done();
    h.pick('door', { width: '0.9' });
    h.click(6, 0);
    expect(inserts(h, 'door')).toHaveLength(0);
    h.click(4.8, 0);
    const d = inserts(h, 'door');
    expect(d).toHaveLength(1);
    expect(parseFloat(d[0].attrs.position)).toBeCloseTo(4.55, 6);
    h.done();
  });
});
