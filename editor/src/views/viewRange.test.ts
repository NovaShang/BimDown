import { describe, it, expect } from 'vitest';
import type { CanonicalElement } from '../model/elements.ts';
import { classifyRange, rangeDisplay } from './viewRange.ts';

const line = (tableName: string, attrs: Record<string, string> = {}): CanonicalElement => ({
  id: 'x-1', tableName, discipline: 'architecture', attrs, geometry: 'line',
  start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, strokeWidth: 0.2,
});
const spatial = (tableName: string, z: number, attrs: Record<string, string> = {}): CanonicalElement => ({
  id: 'x-1', tableName, discipline: 'structure', attrs, geometry: 'spatial_line',
  start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, startZ: z, endZ: z, strokeWidth: 0.2,
});
const poly = (tableName: string, attrs: Record<string, string> = {}): CanonicalElement => ({
  id: 'x-1', tableName, discipline: 'architecture', attrs, geometry: 'polygon',
  vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
});

describe('plan view range', () => {
  it('classifies elements against the cut plane', () => {
    expect(classifyRange(line('wall'), 1.2)).toBe('cut');
    expect(classifyRange(line('wall', { height: '1.0' }), 1.2)).toBe('below');
    expect(classifyRange(line('window'), 1.2)).toBe('cut');                        // 0.9 → 2.4
    expect(classifyRange(line('window', { base_offset: '1.8', height: '0.6' }), 1.2)).toBe('above');
    expect(classifyRange(poly('slab'), 1.2)).toBe('below');
    expect(classifyRange(poly('ceiling', { height_offset: '-0.3' }), 1.2)).toBe('above');
    expect(classifyRange(spatial('beam', 3.0, { size_y: '0.6' }), 1.2)).toBe('above');
    expect(classifyRange(spatial('beam', 1.5, { size_y: '0.6' }), 1.2)).toBe('cut');
    expect(classifyRange(line('railing'), 1.2)).toBe('below');
  });

  it('moving the cut plane changes the class', () => {
    expect(classifyRange(spatial('beam', 3.0, { size_y: '0.6' }), 2.6)).toBe('cut');
    expect(classifyRange(line('window'), 0.5)).toBe('above');
  });

  it('never touches rooms, grids and MEP', () => {
    expect(classifyRange(poly('space'), 1.2)).toBeNull();
    expect(classifyRange(spatial('duct', 2.8), 1.2)).toBeNull();
    expect(classifyRange(line('grid'), 1.2)).toBeNull();
  });

  it('maps classes to plan / RCP display', () => {
    expect(rangeDisplay('above', false, 'dashed')).toBe('overhead');
    expect(rangeDisplay('above', false, 'hidden')).toBe('hidden');
    expect(rangeDisplay('below', false, 'dashed')).toBe('normal');
    expect(rangeDisplay('below', true, 'dashed')).toBe('hidden');
    expect(rangeDisplay('above', true, 'dashed')).toBe('normal');
    expect(rangeDisplay('cut', true, 'hidden')).toBe('normal');
    expect(rangeDisplay(null, true, 'hidden')).toBe('normal');
  });
});
