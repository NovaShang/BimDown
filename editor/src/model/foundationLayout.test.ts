import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { PointElement, PolygonElement } from './elements.ts';
import { padsUnderColumns, pilePattern, pilesInCap } from './foundationLayout.ts';

const col = (id: string, x: number, y: number, attrs: Record<string, string> = {}): PointElement => ({
  id, tableName: 'structure_column', discipline: 'structure', geometry: 'point', position: { x, y }, width: 0.6, height: 0.6,
  attrs: { id, shape: 'rect', size_x: '0.6', size_y: '0.6', ...attrs },
});

describe('batch foundations', () => {
  it('pads under columns: sized by the type, top at the column base, existing footings skipped', () => {
    const cols = [col('sc-1', 0, 0, { base_offset: '-1' }), col('sc-2', 7.2, 0), col('sc-3', 14.4, 0, { rotation: '30' })];
    const existing = [{ ...col('f-1', 7.25, 0), tableName: 'foundation', attrs: { id: 'f-1', kind: 'pad' } } as PointElement];
    const pads = padsUnderColumns(cols, existing, { type_id: 'fdt-pad-2000', width: '2', length: '2.4', thickness: '0.6', material_grade: 'C30' }, ['f-1', 'sc-1']);
    expect(pads.map(p => [p.id, p.position.x, p.attrs.base_offset])).toEqual([['f-2', 0, '-1'], ['f-3', 14.4, '0']]);
    expect(pads[0]).toMatchObject({ width: 2, height: 2.4, attrs: { kind: 'pad', type_id: 'fdt-pad-2000', thickness: '0.6', material_grade: 'C30' } });
    expect(pads[1].attrs.rotation).toBe('30');
  });

  it('pile patterns keep the spacing between neighbours', () => {
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(...(pilePattern(2, 1.8) as [any, any]))).toBeCloseTo(1.8, 9);
    const tri = pilePattern(3, 1.8);
    expect([d(tri[0], tri[1]), d(tri[1], tri[2]), d(tri[2], tri[0])].every(x => Math.abs(x - 1.8) < 1e-9)).toBe(true);
    // centred
    expect(tri.reduce((s, p) => s + p.x, 0)).toBeCloseTo(0, 9);
    expect(tri.reduce((s, p) => s + p.y, 0)).toBeCloseTo(0, 9);
    const five = pilePattern(5, 1.8);
    expect(d(five[0], five[4])).toBeCloseTo(1.8, 9);
    expect(pilePattern(6, 1.8)).toHaveLength(6);
    expect(pilePattern(9, 1.8)).toHaveLength(9);
  });

  it('piles in a cap: centred, along its longest side, hanging from its underside, replacing old piles', () => {
    // 3.6 × 1.8 cap turned 90°: longest side along Y
    const cap: PolygonElement = {
      id: 'f-1', tableName: 'foundation', discipline: 'structure', geometry: 'polygon',
      vertices: [{ x: 10, y: 10 }, { x: 11.8, y: 10 }, { x: 11.8, y: 13.6 }, { x: 10, y: 13.6 }],
      attrs: { id: 'f-1', kind: 'pile_cap', base_offset: '-1.2', thickness: '1.0' },
    };
    const old = { ...col('f-2', 10.9, 11), tableName: 'foundation', attrs: { id: 'f-2', kind: 'pile' } } as PointElement;
    const { piles, replace } = pilesInCap(cap, 2, 1.8, { width: '0.6', thickness: '15' }, ['f-1', 'f-2'], [cap, old]);
    expect(replace).toEqual(['f-2']);
    expect(piles.map(p => [Math.round(p.position.x * 1000) / 1000, Math.round(p.position.y * 1000) / 1000])).toEqual([[10.9, 10.9], [10.9, 12.7]]);
    expect(piles[0].attrs).toMatchObject({ kind: 'pile', base_offset: '-2.2', width: '0.6', thickness: '15' });
    expect(piles.map(p => p.id)).toEqual(['f-3', 'f-4']);
  });
});
