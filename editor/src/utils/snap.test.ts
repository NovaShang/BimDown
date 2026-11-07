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
