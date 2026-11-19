import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { computeRunFlows, sizeSystem, waterDesignFlow } from './calc.ts';

const pipe = (id: string, from: string, to: string, a: [number, number], b: [number, number], system = 'DCW'): CanonicalElement => ({
  id, tableName: 'pipe', discipline: 'mep', geometry: 'spatial_line', start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, startZ: 1, endZ: 1, strokeWidth: 0.02,
  attrs: { id, shape: 'round', size_x: '0.015', system_type: system, from, to },
} as unknown as CanonicalElement);
const fixture = (id: string, type: string, x: number): CanonicalElement => ({
  id, tableName: 'terminal', discipline: 'mep', geometry: 'point', position: { x, y: 1 }, width: 0.5, height: 0.4, attrs: { id, terminal_type: type },
} as unknown as CanonicalElement);
const node = (id: string, x: number): CanonicalElement => ({
  id, tableName: 'mep_node', discipline: 'mep', geometry: 'point', position: { x, y: 0 }, width: 0, height: 0, attrs: { id },
} as unknown as CanonicalElement);

describe('domestic water sizing by loading units (GB 50015)', () => {
  it('design flow 0.2·α·√Ng, never above the fixtures\' sum', () => {
    expect(waterDesignFlow(0.5)).toBeCloseTo(0.1, 9);        // one basin: its own 0.1 L/s
    expect(waterDesignFlow(4)).toBeCloseTo(0.6, 9);          // 0.2 × 1.5 × 2
    expect(waterDesignFlow(25)).toBeCloseTo(1.5, 9);
  });

  it('a cold-water main feeding 4 basins + a sink grows towards the riser; the sanitary network does not leak in', () => {
    const els = [
      fixture('tm-1', 'lavatory', 2), fixture('tm-2', 'lavatory', 4), fixture('tm-3', 'lavatory', 6), fixture('tm-4', 'lavatory', 8), fixture('tm-5', 'sink', 10),
      node('mn-1', 2), node('mn-2', 4), node('mn-3', 6), node('mn-4', 8),
      pipe('pi-1', '', 'mn-1', [0, 0], [2, 0]), pipe('pi-2', 'mn-1', 'mn-2', [2, 0], [4, 0]), pipe('pi-3', 'mn-2', 'mn-3', [4, 0], [6, 0]),
      pipe('pi-4', 'mn-3', 'mn-4', [6, 0], [8, 0]), pipe('pi-5', 'mn-4', 'tm-5:dcw', [8, 0], [10, 1]),
      pipe('pi-11', 'mn-1', 'tm-1:dcw', [2, 0], [2, 1]), pipe('pi-12', 'mn-2', 'tm-2:dcw', [4, 0], [4, 1]),
      pipe('pi-13', 'mn-3', 'tm-3:dcw', [6, 0], [6, 1]), pipe('pi-14', 'mn-4', 'tm-4:dcw', [8, 0], [8, 1]),
      // drains tie the fixtures together on another system
      pipe('pi-21', 'tm-1:drain', 'tm-5:drain', [2, 1], [10, 1], 'SAN'),
    ];
    const m = new Map(els.map(e => [e.id, e]));
    const ng = computeRunFlows(m, { system: 'DCW', loadOf: e => (e.attrs.terminal_type === 'sink' ? 1 : e.attrs.terminal_type === 'lavatory' ? 0.5 : 0) });
    expect(ng.get('pi-1')).toBeCloseTo(3, 9);
    expect(ng.get('pi-4')).toBeCloseTo(1.5, 9);
    expect(ng.get('pi-21')).toBeUndefined();
    const sized = new Map(sizeSystem(m, 'DCW', { transitions: false }).map(e => [e.id, parseFloat(e.attrs.size_x)]));
    const size = (id: string) => sized.get(id) ?? 0.015;
    expect(size('pi-11')).toBe(0.015);            // a basin branch: DN15
    expect(size('pi-1')).toBeGreaterThan(size('pi-11'));   // 3 N → ≈ 0.52 L/s: DN25
    expect(size('pi-1')).toBeGreaterThanOrEqual(size('pi-4'));
    expect(size('pi-1')).toBe(0.025);
  });
});
