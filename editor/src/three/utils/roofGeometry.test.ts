import { describe, it, expect } from 'vitest';
import type { BufferGeometry } from 'three';
import { createRoofGeometry } from './roofGeometry.ts';

/** Signed volume of a closed triangle soup (positive when every face winds outward). */
function volume(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, ay, az] = [p.getX(i), p.getY(i), p.getZ(i)];
    const [bx, by, bz] = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    const [cx, cy, cz] = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function maxY(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  let m = -Infinity;
  for (let i = 0; i < p.count; i++) m = Math.max(m, p.getY(i));
  return m;
}

const rect = (w: number, d: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
const roof = (roofType: string, vertices = rect(4, 3), slopeDeg = 45) =>
  createRoofGeometry({ kind: 'extrude', vertices, baseY: 10, height: 0.2, roofType, slopeDeg })!;

describe('createRoofGeometry', () => {
  it('builds a hip roof with a real ridge (not a flat slab)', () => {
    const g = roof('hip');
    expect(maxY(g)).toBeCloseTo(10.2 + 1.5, 5);          // half span × tan 45°
    // slab 4×3×0.2 + hip solid h·W·(3L − W)/6
    expect(volume(g)).toBeCloseTo(2.4 + (1.5 * 3 * (12 - 3)) / 6, 4);
  });

  it('builds gable, shed and mansard roofs as closed, outward-wound solids', () => {
    expect(volume(roof('gable'))).toBeCloseTo(2.4 + 4 * (3 * 1.5) / 2, 4);
    expect(maxY(roof('shed'))).toBeCloseTo(10.2 + 3, 5);
    expect(volume(roof('shed'))).toBeCloseTo(2.4 + 4 * (3 * 3) / 2, 4);
    const m = roof('mansard', rect(10, 8), 30);
    expect(maxY(m)).toBeCloseTo(10.2 + 4 * 0.3 * Math.tan((50 * Math.PI) / 180), 4);
    expect(volume(m)).toBeGreaterThan(0);
  });

  it('accepts a clockwise footprint', () => {
    const cw = rect(4, 3).reverse();
    expect(volume(roof('hip', cw))).toBeCloseTo(volume(roof('hip')), 6);
  });
});
