import { describe, expect, it } from 'vitest';
import './index.ts';
import { findSteelSection, librarySectionWeight, sectionTypeValues, steelWeightPerMetre, STEEL_SECTIONS, sectionFamilies } from './steelLibrary.ts';
import { resolveSection } from './registry.ts';
import { sectionArea } from '../../model/quantities.ts';

/** Catalogue mass per metre (kg/m): EN 10365 / EN 10210 / EN 10056, AISC (lb/ft × 1.488; HSS: design area A × 7850, AISC's
 *  nominal plf uses the nominal wall), GB/T 11263. */
const TABULATED: [string, number][] = [
  ['HEA 300', 88.3], ['HEB 300', 117], ['IPE 300', 42.2], ['IPE 600', 122],
  ['UPN 200', 25.3], ['L 100x100x10', 15.0],
  ['RHS 200x100x10', 42.6], ['SHS 200x200x10', 57.0], ['CHS 219.1x8', 41.6],
  ['W14X90', 90 * 1.488], ['W24X55', 55 * 1.488], ['HSS8X8X1/2', 13.5 * 0.00064516 * 7850], ['HSS6.625X0.280', 5.2 * 0.00064516 * 7850],
  ['C12X20.7', 20.7 * 1.488], ['L4X4X1/2', 12.8 * 1.488],
  ['HN400x200x8x13', 65.4], ['HW300x300x10x15', 93.0],
];

describe('steel section library', () => {
  it('weights per metre match the catalogues (within 3 %)', () => {
    for (const [name, kg] of TABULATED) {
      const s = findSteelSection(name);
      expect(s, name).toBeDefined();
      const w = librarySectionWeight(s!);
      expect(Math.abs(w - kg) / kg, `${name}: ${w.toFixed(1)} vs ${kg}`).toBeLessThan(0.03);
    }
  });

  it('every entry resolves to a valid section with a positive area', () => {
    for (const s of STEEL_SECTIONS) {
      const v = sectionTypeValues(s);
      const { family } = resolveSection(v.shape, v);
      expect(family.id).toBe(s.shape);
      expect(sectionArea(v)).toBeGreaterThan(0);
    }
    expect(sectionFamilies('EN')).toEqual(['HEA', 'HEB', 'IPE', 'UPN', 'RHS', 'SHS', 'CHS', 'L']);
    expect(sectionFamilies('US')).toEqual(['W', 'HSS rectangular', 'HSS round', 'C', 'L']);
  });

  it('type values are in project units and weight follows them', () => {
    const s = findSteelSection('hea300')!;
    const mm = sectionTypeValues(s, 1000);
    expect(mm).toMatchObject({ shape: 'i_shape', size_x: '300', size_y: '290', flange: '14', web: '8.5', root_radius: '27', designation: 'HEA 300', material_grade: 'S355', material: 'steel' });
    expect(steelWeightPerMetre(mm, 1000)).toBeCloseTo(librarySectionWeight(s), 6);
    expect(steelWeightPerMetre({ ...mm, material: 'concrete' }, 1000)).toBeUndefined();
  });

  it('hollow sections are hollow: area = outer − inner', () => {
    const chs = sectionTypeValues(findSteelSection('CHS 219.1x8')!);
    expect(sectionArea(chs)).toBeCloseTo(Math.PI / 4 * (0.2191 ** 2 - 0.2031 ** 2), 8);
    const { family, params } = resolveSection('rect_hollow', sectionTypeValues(findSteelSection('SHS 200x200x10')!));
    expect(family.holes2D?.(params)).toHaveLength(1);
    expect(family.shape3D(params)).toMatchObject({ kind: 'rect_hollow', thickness: 0.01, radius: 0.015 });
  });
});
