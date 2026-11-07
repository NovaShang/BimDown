import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { buildStaticBatch, releaseStaticBatch, resolveBatchElementId } from './staticBatch.ts';

const wallMat = new MeshStandardMaterial({ color: '#ccc' });
const glassMat = new MeshStandardMaterial({ color: '#9cf', transparent: true, opacity: 0.3 });

/** A row of boxes along +x, one element each, alternating two materials; one mirrored, one hidden. */
function source() {
  const src = new Group();
  for (let i = 0; i < 6; i++) {
    const el = new Group();
    el.userData = { elementId: `lv-1:w-${i}` };
    el.position.set(i * 2, 0, 0);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), i % 2 ? glassMat : wallMat);
    if (i === 4) mesh.scale.set(-1, 1, 1);
    el.add(mesh);
    src.add(el);
  }
  const hidden = new Mesh(new BoxGeometry(1, 1, 1), wallMat);
  hidden.visible = false;
  src.add(hidden);
  const line = new Line(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 3, 0, 4, 3, 0], 3)), new LineBasicMaterial());
  line.userData = { elementId: 'lv-1:g-1' };
  src.add(line);
  return src;
}

function pick(root: Group, x: number) {
  const rc = new Raycaster(new Vector3(x, 0, 10), new Vector3(0, 0, -1));
  const hit = rc.intersectObject(root, true)[0];
  return hit ? (resolveBatchElementId(hit) ?? hit.object.userData.elementId ?? null) : null;
}

describe('static batching', () => {
  it('merges meshes per material, proxies the rest and keeps picking per element', () => {
    const src = source();
    const root = new Group();
    const batch = buildStaticBatch(src);
    for (const o of batch.objects) root.add(o);

    const merged = batch.objects.filter(o => o.userData.batch) as Mesh[];
    expect(merged).toHaveLength(2); // one per material; the hidden mesh is skipped
    expect(merged.reduce((n, m) => n + m.geometry.index!.count / 3, 0)).toBe(6 * 12);
    const proxies = batch.objects.filter(o => !o.userData.batch);
    expect(proxies).toHaveLength(1);
    expect(proxies[0].userData.elementId).toBe('lv-1:g-1');
    expect((proxies[0] as Line).geometry).toBe((src.children[7] as Line).geometry);

    for (let i = 0; i < 6; i++) expect(pick(root, i * 2)).toBe(`lv-1:w-${i}`);
    expect(pick(root, 1)).toBeNull();

    const xs = merged.map(m => m.geometry.boundingBox!);
    expect(Math.min(...xs.map(b => b.min.x))).toBeCloseTo(-0.5);
    expect(Math.max(...xs.map(b => b.max.x))).toBeCloseTo(10.5);

    releaseStaticBatch(batch);
    expect(root.children).toHaveLength(0);
  });

  it('keeps faces front-facing under a mirroring transform', () => {
    const batch = buildStaticBatch(source());
    const glass = batch.objects.find(o => (o as Mesh).material === glassMat) as Mesh;
    const pos = glass.geometry.attributes.position;
    const idx = glass.geometry.index!;
    const nor = glass.geometry.attributes.normal;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      const face = b.sub(a).cross(c.sub(a)).normalize();
      n.fromBufferAttribute(nor, idx.getX(t));
      expect(face.dot(n)).toBeGreaterThan(0.99);
    }
  });
});
