import { describe, it, expect } from 'vitest';
import { clampAndRound, formatForDisplay } from './NumberInput.tsx';

describe('NumberInput display', () => {
  it('shows the stored precision, not the step', () => {
    expect(formatForDisplay('0.065')).toBe('0.065');
    expect(formatForDisplay('1.05')).toBe('1.05');
    expect(formatForDisplay('0.015')).toBe('0.015');
    expect(formatForDisplay('0.30000000000000004')).toBe('0.3');
    expect(formatForDisplay('25.200000000000003')).toBe('25.2');
    expect(formatForDisplay('3')).toBe('3');
    expect(formatForDisplay('')).toBe('');
    expect(formatForDisplay('-')).toBe('-');
  });

  it("nudges keep the value's own precision", () => {
    expect(clampAndRound(1.05 + 0.1, 0.1, undefined, undefined, 1.05)).toBe(1.15);
    expect(clampAndRound(0.065 + 0.01, 0.01, undefined, undefined, 0.065)).toBe(0.075);
    expect(clampAndRound(0.1 + 0.2, 0.1, undefined, undefined, 0.1)).toBe(0.3);
    expect(clampAndRound(-0.05, 0.1, 0, undefined, 0.05)).toBe(0);
  });
});
