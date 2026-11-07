import { describe, it, expect } from 'vitest';
import { BoxGeometry, ExtrudeGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Path, Plane, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeCaps } from './sectionCaps.ts';

/** Sum of fill triangle areas. */
function fillArea(fill: Float32Array): number {
  let s = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < fill.length; i += 9) {
    a.fromArray(fill, i); b.fromArray(fill, i + 3); c.fromArray(fill, i + 6);
    s += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  return s;
}

const mat = new MeshBasicMaterial();
const cut = new Plane(new Vector3(0, 0, -1), 0.25); // keeps z <= 0.25, i.e. cuts at z = 0.25

describe('section caps', () => {
  it('fills the cross-section of a box', () => {
    const root = new Group();
    const m = new Mesh(new BoxGeometry(2, 3, 1), mat);
    m.userData.elementId = 'lv-1:w-1';
    root.add(m);
    const caps = computeCaps(root, cut, 0);
    expect(fillArea(caps.fill)).toBeCloseTo(6, 5);
    expect(new Set(caps.triIds)).toEqual(new Set(['lv-1:w-1']));
    expect(caps.outline.length / 6).toBeGreaterThanOrEqual(4);
  });

  it('leaves holes open', () => {
    const shape = new Shape().moveTo(0, 0).lineTo(4, 0).lineTo(4, 4).lineTo(0, 4).lineTo(0, 0);
    shape.holes.push(new Path().moveTo(1, 1).lineTo(1, 3).lineTo(3, 3).lineTo(3, 1).lineTo(1, 1));
    const root = new Group();
    root.add(new Mesh(new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }), mat));
    const caps = computeCaps(root, new Plane(new Vector3(0, 0, -1), 0.5), 0);
    expect(fillArea(caps.fill)).toBeCloseTo(16 - 4, 4);
  });

  it('handles merged batches and instanced meshes', () => {
    const a = new BoxGeometry(1, 1, 1).translate(0, 0, 0);
    const b = new BoxGeometry(1, 2, 1).translate(5, 0, 0);
    const root = new Group();
    root.add(new Mesh(mergeGeometries([a, b]), mat));
    const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, 2);
    inst.setMatrixAt(0, new Matrix4().makeTranslation(10, 0, 0));
    inst.setMatrixAt(1, new Matrix4().makeTranslation(20, 0, 0));
    inst.userData.indexToId = ['lv-1:c-1', 'lv-1:c-2'];
    root.add(inst);
    const caps = computeCaps(root, cut, 0);
    expect(fillArea(caps.fill)).toBeCloseTo(1 + 2 + 1 + 1, 4);
    expect(caps.triIds).toContain('lv-1:c-2');
  });

  it('skips meshes the plane misses and offsets into the kept side', () => {
    const root = new Group();
    const far = new Mesh(new BoxGeometry(1, 1, 1), mat);
    far.position.set(0, 0, 10);
    root.add(far, new Mesh(new BoxGeometry(1, 1, 1), mat));
    const caps = computeCaps(root, cut, 0.01);
    expect(fillArea(caps.fill)).toBeCloseTo(1, 5);
    for (let i = 2; i < caps.fill.length; i += 3) expect(caps.fill[i]).toBeCloseTo(0.24, 6);
  });
});
