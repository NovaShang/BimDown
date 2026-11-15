import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { comfortableStair, pointsForGoing, stairCalc, assembleStair, STAIR_LIMITS } from '../geometry/stair.ts';
import { STAIR_GOING_KEY } from './drawStairTool.ts';
import type { SpatialLineElement } from '../model/elements.ts';

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
  { id: 'lv-3', number: '3', name: 'Level 3', elevation: 6 },
];

describe('stair tool: typed going, 2R+G fix, multi-storey (G7, G8)', () => {
  it('comfortable risers and going pass every check', () => {
    for (const rise of [2.8, 3, 3.3, 3.6, 4.5]) {
      const f = comfortableStair(rise);
      const L = STAIR_LIMITS;
      expect(f.riser).toBeGreaterThanOrEqual(L.riserMin);
      expect(f.riser).toBeLessThanOrEqual(L.riserMax);
      expect(f.going).toBeGreaterThanOrEqual(L.goingMin);
      const b = 2 * f.riser + f.going;
      expect(b).toBeGreaterThanOrEqual(L.blondelMin - 0.001);
      expect(b).toBeLessThanOrEqual(L.blondelMax + 0.001);
    }
    expect(comfortableStair(3)).toMatchObject({ risers: 18, going: 0.297 });
  });

  it('a typed going sets the length of the last run (straight and L)', () => {
    const straight = pointsForGoing([{ x: 0, y: 0 }, { x: 2, y: 0 }], 1.2, 18, 0.28)!;
    expect(straight[1].x).toBeCloseTo(18 * 0.28, 9);
    const l = pointsForGoing([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }], 1.2, 18, 0.28)!;
    // run 1 = 3 − 0.6, run 2 = y − 0.6: together 18 × 0.28
    expect(l[2].x).toBeCloseTo(3, 9);
    expect(2.4 + (l[2].y - 0.6)).toBeCloseTo(18 * 0.28, 9);
  });

  it('places a straight stair whose treads have the typed going, repeating up to the chosen level', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'straight', width: '1.2', step_count: '18', [STAIR_GOING_KEY]: '0.28', multistory_top_level_id: 'lv-3' });
    h.click(0, 0); h.click(2, 0);
    h.done();
    const stair = [...h.state.document!.elements.values()].find(e => e.tableName === 'stair') as SpatialLineElement;
    expect(stair.end.x).toBeCloseTo(5.04, 6);
    expect(stair.attrs.multistory_top_level_id).toBe('lv-3');
    expect(stair.attrs[STAIR_GOING_KEY]).toBeUndefined();
    const calc = stairCalc(assembleStair(stair, []))!;
    expect(calc.going).toBeCloseTo(0.28, 6);
    expect(calc.checks.every(c => c.ok)).toBe(true);
  });

  it('U stair: every run is locked to risers × going, whatever the clicks (N2: typed 0.3 gave 339 mm)', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'half_turn', width: '1.3', step_count: '18', [STAIR_GOING_KEY]: '0.3' });
    // The audit's clicks: up 3.7 m, across, back down
    h.click(9.25, 5.8); h.click(9.25, 9.5); h.click(10.75, 9.5); h.click(10.75, 5.8);
    h.done();
    const els = [...h.state.document!.elements.values()];
    const stair = els.find(e => e.tableName === 'stair')!;
    const calc = stairCalc(assembleStair(stair, els.filter(e => e.attrs.host_id === stair.id)))!;
    const asm = assembleStair(stair, els.filter(e => e.attrs.host_id === stair.id));
    expect(asm.runs).toHaveLength(2);
    for (const r of asm.runs) expect(r.length / r.stepCount).toBeCloseTo(0.3, 6);
    expect(asm.runs.reduce((n, r) => n + r.stepCount, 0)).toBe(18);
    expect(calc.going).toBeCloseTo(0.3, 6);
    expect(2 * calc.riser + calc.going).toBeCloseTo(0.633, 3);
  });

  it('without a typed going the runs take the default for the riser (2R + G = 630 mm)', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'quarter_turn', width: '1.2', step_count: '18' });
    h.click(0, 0); h.click(3.3, 0); h.click(3.3, 4);
    h.done();
    const els = [...h.state.document!.elements.values()];
    const stair = els.find(e => e.tableName === 'stair')!;
    const asm = assembleStair(stair, els.filter(e => e.attrs.host_id === stair.id));
    for (const r of asm.runs) expect(r.length / r.stepCount).toBeCloseTo(0.297, 6);
    expect(stairCalc(asm)!.checks.every(c => c.ok)).toBe(true);
  });
});
