import { describe, it, expect } from 'vitest';
import { formatElevation } from './units.ts';

describe('formatElevation', () => {
  it('keeps one unit and precision for every floor', () => {
    expect(['-1.25', '0', '-0.15', '4', '12.5'].map(v => formatElevation(Number(v), 'm')))
      .toEqual(['-1.250 m', '0.000 m', '-0.150 m', '4.000 m', '12.500 m']);
    expect(formatElevation(3000, 'mm')).toBe('3000 mm');
    expect(formatElevation(10, 'ft')).toBe('10.00 ft');
  });

  it('never shows a negative zero', () => {
    expect(formatElevation(-0.0001, 'm')).toBe('0.000 m');
    expect(formatElevation(NaN, 'm')).toBe('0.000 m');
  });
});
