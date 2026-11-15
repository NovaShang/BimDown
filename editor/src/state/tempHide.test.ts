import { describe, it, expect } from 'vitest';
import { applyTempHide, getTempHide, setTempHide, tempHideCss } from './tempHide.ts';
import { TWO_LETTER } from '../tools/shortcuts.ts';

describe('temporary hide / isolate', () => {
  it('accumulates hides, replaces on isolate, resets', () => {
    applyTempHide('hide', ['w-1'], []);
    applyTempHide('hide', ['w-2'], ['architecture/door']);
    expect(getTempHide()).toEqual({ mode: 'hide', ids: ['w-1', 'w-2'], layers: ['architecture/door'] });
    expect(tempHideCss(getTempHide())).toContain('[data-id="w-2"]');
    expect(tempHideCss(getTempHide())).toContain('[data-layer="architecture/door"]');
    applyTempHide('isolate', ['w-3'], []);
    expect(tempHideCss(getTempHide())).toBe('.canvas-svg .data-layer [data-id]:not([data-id="w-3"]){display:none}');
    setTempHide(null);
    expect(tempHideCss(getTempHide())).toBe('');
  });

  it('has the Revit view and modify commands', () => {
    const keys = TWO_LETTER.map(s => s.keys);
    for (const k of ['CS', 'MA', 'HH', 'HI', 'HC', 'IC', 'HR', 'VV']) expect(keys).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
