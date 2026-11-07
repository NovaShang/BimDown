import { describe, expect, it } from 'vitest';
import { Box3, Vector3, type BufferGeometry } from 'three';
import { buildStraightWallSolid } from './wallSolid.ts';
import { extrudeWallWithCsg, type LineWallFacts, type WallOpening } from '../../elements/_lineWallShared.tsx';
import type { Point } from '../../model/elements.ts';

/** Signed volume of a closed triangle mesh (divergence theorem). */
function volume(geo: BufferGeometry): number {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  let v = 0;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

function opening(position: number, width: number, height: number, sillHeight = 0, shape: WallOpening['shape'] = 'rect'): WallOpening {
  return { hostedId: 'd-1', hostedTable: 'door', position, width, height, sillHeight, shape };
}

function facts(start: Point, end: Point, footprint: Point[], openings: WallOpening[], height = 3, baseY = 4): LineWallFacts {
  return {
    id: 'w-1', table: 'wall', centerline: { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) },
    footprint, segments: [], openings, thickness: 0.2, height, baseY, material: 'brick',
  };
}

/** A 0.2 m wall from (1,2) at 30°, 5 m long, mitered at 45° on the start and square at the end. */
const angle = Math.PI / 6;
const u = { x: Math.cos(angle), y: Math.sin(angle) }, nrm = { x: -u.y, y: u.x };
const at = (t: number, s: number): Point => ({ x: 1 + u.x * t + nrm.x * s, y: 2 + u.y * t + nrm.y * s });
const start = at(0, 0), end = at(5, 0);
const footprint = [at(-0.1, 0.1), at(5, 0.1), at(5, -0.1), at(0.1, -0.1)];

describe('direct wall solid', () => {
  const cases: [string, WallOpening[]][] = [
    ['plain', []],
    ['door', [opening(2, 0.9, 2.1)]],
    ['window with sill', [opening(2, 1.2, 1.2, 0.9)]],
    ['several, one touching the mitered start', [opening(0.3, 0.6, 2.1), opening(2, 1, 1.5, 0.6), opening(3.5, 0.8, 2.1)]],
    ['past the far end and above the top', [opening(4.8, 1, 5, 0.5)]],
    ['full-height gap', [opening(2.5, 1, 3)]],
  ];
  it.each(cases)('%s: same solid as extrude + CSG', (_name, ops) => {
    const f = facts(start, end, footprint, ops);
    const direct = buildStraightWallSolid({ start, end, footprint, thickness: 0.2, height: 3, baseY: 4, openings: ops })!;
    expect(direct).not.toBeNull();
    const csg = extrudeWallWithCsg(f);
    expect(volume(direct)).toBeCloseTo(volume(csg), 5);
    const bd = new Box3().setFromBufferAttribute(direct.attributes.position as never);
    const bc = new Box3().setFromBufferAttribute(csg.attributes.position as never);
    expect(bd.min.distanceTo(bc.min)).toBeLessThan(1e-5);
    expect(bd.max.distanceTo(bc.max)).toBeLessThan(1e-5);
    // Flat normals pointing out of each face (front faces wound CCW).
    const p = direct.attributes.position, n = direct.attributes.normal;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), m = new Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      const face = b.sub(a).cross(c.sub(a)).normalize();
      expect(face.dot(m.fromBufferAttribute(n, i))).toBeGreaterThan(0.999);
    }
  });

  it('leaves round / overlapping openings to CSG', () => {
    const base = { start, end, footprint, thickness: 0.2, height: 3, baseY: 0 };
    expect(buildStraightWallSolid({ ...base, openings: [opening(2, 1, 1, 1, 'round')] })).toBeNull();
    expect(buildStraightWallSolid({ ...base, openings: [opening(2, 1, 2), opening(2.5, 1, 2)] })).toBeNull();
  });
});
