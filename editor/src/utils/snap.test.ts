import { describe, expect, it } from 'vitest';
import '../elements/registerAll.ts';
import { computeSnap } from './snap.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';

/** A map that hides its size, so computeSnap scans every element (no spatial index). */
class UnindexedMap<K, V> extends Map<K, V> {
  get size() { return 0; }
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function model(): Map<string, CanonicalElement> {
  const r = rng(3);
  const m = new Map<string, CanonicalElement>();
  const base = { discipline: 'architecture', attrs: {} };
  for (let i = 0; i < 400; i++) {
    const x = r() * 80, y = r() * 50, len = 1 + r() * 8, a = r() * Math.PI;
    m.set(`w-${i}`, {
      ...base, id: `w-${i}`, tableName: 'wall', geometry: 'line', strokeWidth: 0.2,
      start: { x, y }, end: { x: x + Math.cos(a) * len, y: y + Math.sin(a) * len },
      ...(i % 25 === 0 ? { arc: { rx: 3, ry: 3, rotation: 0, largeArc: i % 50 === 0, sweep: true } } : {}),
    } as CanonicalElement);
  }
  for (let i = 0; i < 100; i++) {
    m.set(`c-${i}`, { ...base, id: `c-${i}`, tableName: 'column', geometry: 'point', position: { x: r() * 80, y: r() * 50 }, width: 0.4, height: 0.4 } as CanonicalElement);
  }
  for (let i = 0; i < 40; i++) {
    const x = r() * 80, y = r() * 50;
    m.set(`sl-${i}`, { ...base, id: `sl-${i}`, tableName: 'slab', geometry: 'polygon', vertices: [{ x, y }, { x: x + 3, y }, { x: x + 3, y: y + 2 }, { x, y: y + 2 }] } as CanonicalElement);
  }
  return m;
}

describe('snap spatial index', () => {
  it('gives the same result as scanning every element', () => {
    const m = model();
    const all = new UnindexedMap(m);
    const r = rng(11);
    for (let i = 0; i < 400; i++) {
      const p: Point = { x: r() * 90 - 5, y: r() * 60 - 5 };
      const pixel = [0.002, 0.01, 0.05, 0.3][i % 4];
      const anchor = i % 3 === 0 ? { x: r() * 80, y: r() * 50 } : undefined;
      const exclude = new Set(i % 5 === 0 ? ['w-1', 'c-2'] : []);
      expect(computeSnap(p, pixel, m, exclude, anchor)).toEqual(computeSnap(p, pixel, all, exclude, anchor));
    }
  });
});

describe('round-value snaps stay at the click (audit r3: cap clicked at (20.4, 24.0) landed at (20, 24.3))', () => {
  // The audit's grid: 1-4 at x = 0 / 7.2 / 14.4 / 21.6, A-D at y = 0 / 8.4 / 16.8 / 25.2; ~21 px per metre
  const grids = [
    ...[0, 7.2, 14.4, 21.6].map((x, i) => ({ id: `gr-${i + 1}`, number: String(i + 1), x1: x, y1: 27.5, x2: x, y2: -2.5 })),
    ...[0, 8.4, 16.8, 25.2].map((y, i) => ({ id: `gr-${i + 5}`, number: 'ABCD'[i], x1: -2.5, y1: y, x2: 25, y2: y })),
  ];
  const px = 1 / 21;
  const snap = (p: Point, anchor?: Point) => computeSnap(p, px, new Map(), undefined, anchor, undefined, grids).point;

  it('a free click is not pulled to round distances off a far grid', () => {
    expect(snap({ x: 20.4, y: 24.0 })).toEqual({ x: 20.4, y: 24.0 });
    expect(snap({ x: 20.4, y: 15.6 })).toEqual({ x: 20.4, y: 15.6 });
  });

  it('a segment keeps its clicked length (2.4 m is not rounded to 2.5 m)', () => {
    const p = snap({ x: 22.8, y: 24.0 }, { x: 20.4, y: 24.0 });
    expect(p.x).toBeCloseTo(22.8, 9);
    expect(p.y).toBeCloseTo(24.0, 9);
  });

  it('a click within a pixel or two of a round value still lands on it', () => {
    // 1.01 m off grid 4 rounds to 1.0; 2.49 m long rounds to 2.5
    expect(snap({ x: 20.59, y: 20 }).x).toBeCloseTo(20.6, 9);
    const p = snap({ x: 22.89, y: 24.0 }, { x: 20.4, y: 24.0 });
    expect(p.x).toBeCloseTo(22.9, 9);
  });

  it('aligning with a far point captures only a few pixels either side', () => {
    const term = new Map<string, CanonicalElement>([['t-1', { id: 't-1', tableName: 'terminal', discipline: 'mep', geometry: 'point', position: { x: 10, y: 2 }, width: 0.3, height: 0.3, attrs: {} } as CanonicalElement]]);
    // 0.15 m (~3 px) off the terminal's X, 10 m away along Y: aligned
    expect(computeSnap({ x: 10.15, y: 12 }, px, term).point.x).toBe(10);
    // 0.3 m (~6 px) off: not pulled
    expect(computeSnap({ x: 10.3, y: 12 }, px, term).point.x).toBe(10.3);
    // right next to it the full 10 px still applies
    expect(computeSnap({ x: 10.4, y: 2.1 }, px, term).point).toEqual({ x: 10, y: 2 });
  });
});
