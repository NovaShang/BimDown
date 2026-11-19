import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { assembleStair, stairCalc, totalRisers, winderGeometry } from '../geometry/stair.ts';
import { STAIR_GOING_KEY } from './drawStairTool.ts';
import { SKETCH_MODE_KEY, STAIR_TURN_KEY } from '../model/stairElements.ts';
import type { CanonicalElement } from '../model/elements.ts';

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3.06 },
];

function stairs(els: CanonicalElement[]) {
  return els.filter(e => e.tableName === 'stair').map(s => ({
    stair: s, asm: assembleStair(s, els.filter(e => e.attrs.host_id === s.id)),
  }));
}

describe('stair tool: winders, curved, sketch', () => {
  it('Winder type: an L whose corner turns as 3 winders, all 18 risers equal', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'winder', width: '1.2', step_count: '18', [STAIR_GOING_KEY]: '0.28' });
    h.click(0, 0); h.click(2.5, 0); h.click(2.5, 4);
    h.done();
    const [{ stair, asm }] = stairs([...h.state.document!.elements.values()]);
    expect(stair.attrs.stair_type).toBe('winder');
    expect(asm.landings[0].steps).toBe(3);
    expect(totalRisers(asm)).toBe(18);
    for (const r of asm.runs) expect(r.length / r.stepCount).toBeCloseTo(0.28, 6);
    expect(winderGeometry(asm, asm.landings[0])!.treads).toHaveLength(3);
    expect(stairCalc(asm)!.riser).toBeCloseTo(0.17, 6);
  });

  it('U-shape with Turn = Winders: 6 winders in the half turn', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'half_turn', [STAIR_TURN_KEY]: 'winders', width: '1.2', step_count: '18' });
    h.click(0, 0); h.click(2, 0); h.click(2, 1.4); h.click(0, 1.4);
    h.done();
    const [{ stair, asm }] = stairs([...h.state.document!.elements.values()]);
    expect(stair.attrs.stair_type).toBe('winder');
    expect(asm.landings[0].steps).toBe(6);
    expect(totalRisers(asm)).toBe(18);
  });

  it('Curved: centre, walking line, direction → one arc run of steps × going', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'curved', width: '1.2', step_count: '18', [STAIR_GOING_KEY]: '0.3' });
    h.click(0, 0); h.click(3, 0); h.click(0, 3);
    h.done();
    const [{ stair, asm }] = stairs([...h.state.document!.elements.values()]);
    expect((stair as { arc?: unknown }).arc).toBeDefined();
    expect(stair.attrs.stair_type).toBe('curved');
    expect(asm.runs[0].arc!.sweep).toBeCloseTo(18 * 0.3 / 3, 6);
    expect(asm.runs[0].endZ).toBeCloseTo(3.06, 6);
  });

  it('Spiral clockwise past 270° makes two arc runs round the same centre', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { stair_type: 'spiral', width: '0.9', step_count: '18', [STAIR_GOING_KEY]: '0.25' });
    h.click(5, 5); h.click(5.8, 5); h.click(5, 4);
    h.done();
    const [{ asm }] = stairs([...h.state.document!.elements.values()]);
    expect(asm.runs).toHaveLength(2);
    for (const r of asm.runs) expect(r.arc!.sweep).toBeLessThan(0);
    expect(asm.runs.reduce((s, r) => s + r.stepCount, 0)).toBe(18);
  });

  it('Sketch: boundary + risers → stair, Enter builds it as one undo step', () => {
    const h = createHarness(LEVELS);
    h.pick('stair', { [SKETCH_MODE_KEY]: 'boundary' }, 'sketch');
    for (const [x, y] of [[0, 0], [5.04, 0], [5.04, 1.2], [0, 1.2], [0, 0]]) h.click(x, y);
    expect(h.state.drawingState?.stairSketch?.boundary).toHaveLength(4);
    expect(h.state.drawingAttrs[SKETCH_MODE_KEY]).toBe('riser');
    for (let i = 0; i < 18; i++) { h.click(i * 0.28, 0); h.click(i * 0.28, 1.2); }
    expect(h.key('Backspace')).toBe(true);
    h.click(17 * 0.28, 0); h.click(17 * 0.28, 1.2);
    expect(h.key('Enter')).toBe(true);
    const [{ stair, asm }] = stairs([...h.state.document!.elements.values()]);
    expect(stair.attrs.stair_type).toBe('straight');
    expect(asm.runs[0].stepCount).toBe(18);
    expect(asm.runs[0].length).toBeCloseTo(5.04, 6);
    expect(stairCalc(asm)!.checks.every(c => c.ok)).toBe(true);
  });
});
