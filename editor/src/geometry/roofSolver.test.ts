import { describe, it, expect } from 'vitest';
import {
  solveRoof, roofSolidTriangles, legacyEdgeSlopes, roofInputFor, signedArea, type P2, type V3, type RoofLine,
} from './roofSolver.ts';

const rect = (w: number, h: number): P2[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
// L: 10 × 10 with a 6 × 6 notch top-right, wings 4 m wide.
const L: P2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
// T: 12 m bar (3 deep) with a 2 m stem going up 6 m.
const T: P2[] = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 9 }, { x: 5, y: 9 }, { x: 5, y: 3 }, { x: 0, y: 3 }];

const near = (a: P2, b: P2, tol = 1e-3) => Math.hypot(a.x - b.x, a.y - b.y) < tol;
const hasLine = (lines: RoofLine[], a: P2, b: P2, kind?: string) =>
  lines.some(l => (kind === undefined || l.kind === kind) && ((near(l.a, a) && near(l.b, b)) || (near(l.a, b) && near(l.b, a))));

function volume(tris: V3[][]): number {
  let v = 0;
  for (const [a, b, c] of tris) {
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
}

describe('solveRoof', () => {
  it('hip rectangle: ridge between the hips, rise = half the span', () => {
    const s = solveRoof({ outline: rect(10, 6), edgeSlopes: [45, 45, 45, 45] });
    expect(s.rise({ x: 5, y: 3 })).toBeCloseTo(3);
    expect(s.rise({ x: 1, y: 3 })).toBeCloseTo(1);
    expect(s.maxRise).toBeCloseTo(3);
    expect(hasLine(s.lines, { x: 3, y: 3 }, { x: 7, y: 3 }, 'ridge')).toBe(true);
    for (const [c, r] of [[{ x: 0, y: 0 }, { x: 3, y: 3 }], [{ x: 10, y: 0 }, { x: 7, y: 3 }], [{ x: 10, y: 6 }, { x: 7, y: 3 }], [{ x: 0, y: 6 }, { x: 3, y: 3 }]]) {
      expect(hasLine(s.lines, c, r, 'hip')).toBe(true);
    }
    expect(s.lines.length).toBe(5);
  });

  it('gable rectangle: ridge runs to the gable ends, works clockwise too', () => {
    for (const outline of [rect(10, 6), rect(10, 6).reverse()]) {
      const slopes = outline === rect(10, 6) ? [30, 0, 30, 0] : legacyEdgeSlopes(outline, 'gable', 30);
      const s = solveRoof({ outline, edgeSlopes: slopes });
      const t = Math.tan(Math.PI / 6);
      expect(s.rise({ x: 0.2, y: 3 })).toBeCloseTo(3 * t);
      expect(s.rise({ x: 5, y: 1 })).toBeCloseTo(1 * t);
      expect(hasLine(s.lines, { x: 0, y: 3 }, { x: 10, y: 3 }, 'ridge')).toBe(true);
      expect(s.lines.length).toBe(1);
    }
  });

  it('L-shaped hip roof: valley at the re-entrant corner, both wings full height', () => {
    const s = solveRoof({ outline: L, edgeSlopes: L.map(() => 45) });
    expect(s.rise({ x: 2, y: 8 })).toBeCloseTo(2);
    expect(s.rise({ x: 8, y: 2 })).toBeCloseTo(2);
    expect(s.rise({ x: 3, y: 3 })).toBeCloseTo(1);
    expect(s.rise({ x: 3.5, y: 2 })).toBeCloseTo(2);
    expect(s.rise({ x: 2, y: 2 })).toBeCloseTo(2);
    expect(hasLine(s.lines, { x: 4, y: 4 }, { x: 2, y: 2 }, 'valley')).toBe(true);
    expect(hasLine(s.lines, { x: 0, y: 0 }, { x: 2, y: 2 }, 'hip')).toBe(true);
    expect(hasLine(s.lines, { x: 2, y: 2 }, { x: 8, y: 2 }, 'ridge')).toBe(true);
    expect(hasLine(s.lines, { x: 2, y: 2 }, { x: 2, y: 8 }, 'ridge')).toBe(true);
  });

  it('L-shaped gable roof: two ridges to the wing ends, one valley, one hip', () => {
    const slopes = legacyEdgeSlopes(L, 'gable', 45);
    expect(slopes).toEqual([45, 0, 45, 45, 0, 45]);
    const s = solveRoof({ outline: L, edgeSlopes: slopes });
    expect(s.rise({ x: 9.9, y: 2 })).toBeCloseTo(2);
    expect(s.rise({ x: 2, y: 9.9 })).toBeCloseTo(2);
    expect(hasLine(s.lines, { x: 2, y: 2 }, { x: 10, y: 2 }, 'ridge')).toBe(true);
    expect(hasLine(s.lines, { x: 2, y: 2 }, { x: 2, y: 10 }, 'ridge')).toBe(true);
    expect(hasLine(s.lines, { x: 4, y: 4 }, { x: 2, y: 2 }, 'valley')).toBe(true);
    expect(hasLine(s.lines, { x: 0, y: 0 }, { x: 2, y: 2 }, 'hip')).toBe(true);
    expect(s.lines.length).toBe(4);
  });

  it('T-shaped gable roof: stem ridge meets the bar ridge, two valleys', () => {
    const slopes = legacyEdgeSlopes(T, 'gable', 45);
    // Wing ends: right end, stem top, left end.
    expect(slopes.map(v => v > 0)).toEqual([true, false, true, true, false, true, true, false]);
    const s = solveRoof({ outline: T, edgeSlopes: slopes });
    expect(s.rise({ x: 1, y: 1.5 })).toBeCloseTo(1.5);
    expect(s.rise({ x: 6, y: 8.9 })).toBeCloseTo(1);
    expect(s.rise({ x: 6, y: 5 })).toBeCloseTo(1);
    expect(s.lines.filter(l => l.kind === 'valley').length).toBe(2);
    expect(hasLine(s.lines, { x: 0, y: 1.5 }, { x: 12, y: 1.5 }, 'ridge')).toBe(true);
  });

  it('shed: one eave, rising across', () => {
    const slopes = legacyEdgeSlopes(rect(8, 4), 'shed', 10);
    expect(slopes).toEqual([10, 0, 0, 0]);
    const s = solveRoof({ outline: rect(8, 4), edgeSlopes: slopes });
    expect(s.rise({ x: 4, y: 4 })).toBeCloseTo(4 * Math.tan(Math.PI / 18));
    expect(s.lines.length).toBe(0);
  });

  it('flat roof with drainage falls to one edge', () => {
    const s = solveRoof(roofInputFor(rect(10, 6), { roof_type: 'flat', edge_slopes: '1.15;0;0;0' }));
    expect(s.rise({ x: 5, y: 6 })).toBeCloseTo(6 * Math.tan((1.15 * Math.PI) / 180));
  });

  it('mansard: steep sides capped by a flat deck', () => {
    const s = solveRoof(roofInputFor(rect(10, 6), { roof_type: 'mansard', slope: '30' }));
    const cap = 3 * 0.3 * Math.tan((50 * Math.PI) / 180);
    expect(s.rise({ x: 5, y: 3 })).toBeCloseTo(cap);
    expect(s.rise({ x: 0.3, y: 3 })).toBeCloseTo(0.3 * Math.tan((50 * Math.PI) / 180));
  });

  it('extrusion roof follows its profile across the first edge', () => {
    const s = solveRoof(roofInputFor(rect(10, 6), { roof_type: 'extrusion', profile: '0,0;3,1.5;6,0' }));
    expect(s.rise({ x: 4, y: 3 })).toBeCloseTo(1.5);
    expect(s.rise({ x: 4, y: 1 })).toBeCloseTo(0.5);
    expect(hasLine(s.lines, { x: 0, y: 3 }, { x: 10, y: 3 }, 'ridge')).toBe(true);
  });

  it('roof solid is closed: volume = area × vertical thickness, holes subtract', () => {
    for (const [outline, slopes] of [[rect(10, 6), [45, 45, 45, 45]], [L, legacyEdgeSlopes(L, 'gable', 40)], [T, T.map(() => 35)]] as const) {
      const s = solveRoof({ outline: [...outline], edgeSlopes: [...slopes] });
      const tris = roofSolidTriangles(s, [...outline], 3, 0.25);
      expect(volume(tris)).toBeCloseTo(Math.abs(signedArea([...outline])) * 0.25, 4);
    }
    const s = solveRoof({ outline: rect(10, 6), edgeSlopes: [45, 45, 45, 45] });
    const hole = [{ x: 4, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 4, y: 2 }];
    expect(volume(roofSolidTriangles(s, rect(10, 6), 0, 0.2, [hole]))).toBeCloseTo((60 - 1) * 0.2, 4);
  });

  it('legacy hip/gable on rectangles match the old bounding-box planes', () => {
    expect(legacyEdgeSlopes(rect(10, 6), 'gable', 30)).toEqual([30, 0, 30, 0]);
    expect(legacyEdgeSlopes(rect(6, 10), 'gable', 30)).toEqual([0, 30, 0, 30]);
    expect(legacyEdgeSlopes(rect(6, 6), 'gable', 30)).toEqual([30, 0, 30, 0]);
    expect(legacyEdgeSlopes(rect(10, 6), 'hip', 30)).toEqual([30, 30, 30, 30]);
  });

  it('convex footprints: exactly the lower envelope of all eave planes', () => {
    const hex = Array.from({ length: 6 }, (_, i) => ({ x: 5 * Math.cos((i * Math.PI) / 3), y: 5 * Math.sin((i * Math.PI) / 3) }));
    const s = solveRoof({ outline: hex, edgeSlopes: hex.map(() => 30) });
    expect(s.rise({ x: 0, y: 0 })).toBeCloseTo(5 * Math.cos(Math.PI / 6) * Math.tan(Math.PI / 6));
    expect(s.lines.filter(l => l.kind === 'hip').length).toBe(6);
    const quad = [{ x: 0, y: 0 }, { x: 9, y: 1 }, { x: 8, y: 7 }, { x: 1, y: 5 }];
    const q = solveRoof({ outline: quad, edgeSlopes: [20, 35, 20, 35] });
    const env = (p: P2) => Math.min(...quad.map((a, i) => {
      const b = quad[(i + 1) % 4], len = Math.hypot(b.x - a.x, b.y - a.y);
      const d = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
      return d * Math.tan(((i % 2 ? 35 : 20) * Math.PI) / 180);
    }));
    for (const p of [{ x: 4, y: 3 }, { x: 2, y: 2 }, { x: 7, y: 5 }, { x: 5, y: 1.5 }]) expect(q.rise(p)).toBeCloseTo(env(p));
  });

  it('U-shaped hip roof: both arms and the base keep their own ridges', () => {
    const U: P2[] = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 8 }, { x: 0, y: 8 }];
    const s = solveRoof({ outline: U, edgeSlopes: U.map(() => 45) });
    expect(s.rise({ x: 2, y: 6 })).toBeCloseTo(2);
    expect(s.rise({ x: 10, y: 6 })).toBeCloseTo(2);
    expect(s.rise({ x: 6, y: 1.5 })).toBeCloseTo(1.5);
    expect(s.rise({ x: 6, y: 2.9 })).toBeCloseTo(0.1);
    expect(s.lines.filter(l => l.kind === 'valley').length).toBe(2);
  });
});
