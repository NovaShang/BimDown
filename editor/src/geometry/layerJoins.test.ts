import { describe, it, expect } from 'vitest';
import { fineJoins, cutBand, cutChord, coreFace, type JoinWall } from './layerJoins.ts';
import { planDetailFor, planPens } from '../components/planDetail.ts';

// Exterior wall along +x, 0.32 thick, exterior (left, +y) first:
// brick 0.1 | air 0.04 | insulation 0.07 | core brick 0.1 | plaster 0.01
const bands = [
  { lo: 0.06, hi: 0.16, material: 'brick', function: 'finish' },
  { lo: 0.02, hi: 0.06, material: '', function: 'air_gap' },
  { lo: -0.05, hi: 0.02, material: 'insulation', function: 'insulation' },
  { lo: -0.15, hi: -0.05, material: 'brick', function: 'core' },
  { lo: -0.16, hi: -0.15, material: 'gypsum', function: 'finish' },
];
const main: JoinWall = { id: 'w-1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, thickness: 0.32, bands };
// Partition teeing in from the inside (−y), ending on the main centre line
const stem: JoinWall = { id: 'w-2', start: { x: 4, y: -5 }, end: { x: 4, y: 0 }, thickness: 0.1 };

describe('layered tee joins (fine detail)', () => {
  it('runs the stem through the inner finish to the core face', () => {
    expect(coreFace(main, -1)).toBeCloseTo(-0.15);
    expect(coreFace(main, 1)).toBeCloseTo(-0.05);
    const j = fineJoins(new Map([[main.id, main], [stem.id, stem]]), [{ tWallId: 'w-2', tWhich: 'end', mainWallId: 'w-1' }]);
    const end = j.stems.get('w-2:end')!;
    expect(end.left.y).toBeCloseTo(-0.15);
    expect(end.right.y).toBeCloseTo(-0.15);
    expect(Math.min(end.left.x, end.right.x)).toBeCloseTo(3.95);
    expect(Math.max(end.left.x, end.right.x)).toBeCloseTo(4.05);
    const cut = j.cuts.get('w-1')![0];
    expect(cut.a0).toBeCloseTo(3.95);
    expect(cut.a1).toBeCloseTo(4.05);
    expect(cut.lo).toBeCloseTo(-0.16);
    expect(cut.hi).toBeCloseTo(-0.15);
    // The plaster band loses the stem's width; the core and the outer layers keep theirs
    const plaster = [{ x: 0, y: -0.16 }, { x: 10, y: -0.16 }, { x: 10, y: -0.15 }, { x: 0, y: -0.15 }];
    const pieces = cutBand(plaster, main.start, main.end, -0.16, -0.15, [cut]);
    expect(pieces).toHaveLength(2);
    expect(Math.max(...pieces[0].map(p => p.x))).toBeCloseTo(3.95);
    expect(Math.min(...pieces[1].map(p => p.x))).toBeCloseTo(4.05);
    const core = [{ x: 0, y: -0.15 }, { x: 10, y: -0.15 }, { x: 10, y: -0.05 }, { x: 0, y: -0.05 }];
    expect(cutBand(core, main.start, main.end, -0.15, -0.05, [cut])).toHaveLength(1);
    // The plaster / core joint is open where the stem meets the core
    expect(cutChord([{ x: 0, y: -0.15 }, { x: 10, y: -0.15 }], main.start, main.end, -0.15, [cut])).toHaveLength(2);
    expect(cutChord([{ x: 0, y: 0.06 }, { x: 10, y: 0.06 }], main.start, main.end, 0.06, [cut])).toHaveLength(1);
  });

  it('leaves single-material main walls alone', () => {
    const plain = { ...main, bands: undefined };
    const j = fineJoins(new Map([[plain.id, plain], [stem.id, stem]]), [{ tWallId: 'w-2', tWhich: 'end', mainWallId: 'w-1' }]);
    expect(j.stems.size).toBe(0);
  });
});

describe('plan detail by zoom', () => {
  it('shows layers from about 1:50 and keeps pens steady on screen', () => {
    expect(planDetailFor(10)).toBe('coarse');
    expect(planDetailFor(30)).toBe('medium');
    expect(planDetailFor(80)).toBe('fine');
    // Pens are pixels / bucket (a power of two): within a factor of √2 of the target on screen
    for (const ppu of [20, 37, 64, 100, 300]) {
      const p = planPens(ppu, 'medium');
      expect(p.cut * ppu).toBeGreaterThan(1.6 / Math.SQRT2 - 1e-9);
      expect(p.cut * ppu).toBeLessThan(1.6 * Math.SQRT2 + 1e-9);
    }
    expect(planPens(40, 'fine').bucket).toBe(32);
  });
});
