import { describe, it, expect } from 'vitest';
import { clipConvex, elevationSurfaces } from './elevationSurfaces.ts';
import type { ViewPart } from './viewSolids.ts';

const quad = (x0: number, x1: number, z0: number, z1: number, y: number): number[] =>
  // Two triangles of a face in the plane y, normal −y (looking at a viewer on −y)
  [x0, y, z0, x1, y, z1, x0, y, z1, x0, y, z0, x1, y, z0, x1, y, z1];

const part = (id: string, cls: ViewPart['cls'], tris: number[], material?: string): ViewPart =>
  ({ id, table: 'wall', cls, tris, sharp: [], smooth: [], material });

const proj = (x: number, y: number, z: number) => ({ u: x, v: z, d: y });
const opts = { upm: 1, pm: 0.1, fillLayer: 'F', hatchLayer: 'H', shadowLayer: 'S' };

describe('rendered elevations', () => {
  it('clips a polygon to a convex one', () => {
    const r = clipConvex([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]);
    const xs = r.map(p => p.x), ys = r.map(p => p.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 1, 0, 1]);
  });

  it('tints faces looking at the viewer by material, courses brick, casts the eave shadow down-right', () => {
    const wall = part('w-1', 'wall', quad(0, 10, 0, 3, 0), 'brick');
    // A canopy 1 m in front of the wall: its front face at y = −1, 2.6 … 3 m high, 2 … 4 m along
    const canopy = part('ro-1', 'roof', quad(2, 4, 2.6, 3, -1));
    const items = elevationSurfaces([wall, canopy], proj, { x: 0, y: 1 }, opts);
    const fills = items.filter(i => i.kind === 'path' && i.layer === 'F');
    expect(fills).toHaveLength(4);
    expect(fills.some(i => i.kind === 'path' && i.fill === '#ecd3c3')).toBe(true);
    const courses = items.filter(i => i.layer === 'H');
    expect(courses.length).toBeGreaterThan(30); // 3 m at 75 mm
    const shadows = items.filter(i => i.layer === 'S');
    expect(shadows.length).toBeGreaterThan(0);
    for (const s of shadows) if (s.kind === 'path') for (const p of s.pts) {
      // Moved 1 m right and down, inside the wall
      expect(p.x).toBeGreaterThanOrEqual(3 - 1e-9); expect(p.x).toBeLessThanOrEqual(5 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(1.6 - 1e-9); expect(p.y).toBeLessThanOrEqual(2 + 1e-9);
    }
    // Painter's order: the wall (far) before the canopy (near), shadows after the wall's fill
    const wallIdx = items.findIndex(i => i.layer === 'F');
    const shadowIdx = items.findIndex(i => i.layer === 'S');
    expect(shadowIdx).toBeGreaterThan(wallIdx);
  });
});
