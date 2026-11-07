/**
 * Static batching for the 3D view: merges the per-element meshes of a floor
 * into one mesh per material, so a 10k-element model costs a few dozen draw
 * calls instead of tens of thousands, and raycasts hit a BVH instead of
 * every mesh in turn.
 *
 * The element meshes are rendered by React/R3F into a group that is not part
 * of the scene (a portal), so per-frame scene traversal only sees the merged
 * meshes. Anything that can't be merged is shown through a lightweight proxy
 * (a shallow clone sharing geometry and material). Picking resolves a
 * merged-mesh hit back to the element through the source vertex ranges
 * (`resolveBatchElementId`).
 */
import {
  BufferAttribute, BufferGeometry, Matrix3, Matrix4, Mesh, Object3D, Vector3,
  type Intersection, type Material, type Raycaster,
} from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** userData on merged meshes: element id per source vertex range. */
export interface BatchUserData {
  batch: true;
  /** First vertex of each source range, ascending. */
  vertexStarts: Uint32Array;
  /** Element id of each range (null when the source had none). */
  ids: (string | null)[];
}

interface Source {
  mesh: Mesh;
  elementId: string | null;
  /** mesh.matrixWorld relative to the source root. */
  matrix: Matrix4;
}

interface Group {
  material: Material;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  hasUv: boolean;
  sources: Source[];
}

export interface StaticBatch {
  /** Merged meshes and proxies, to add to a group placed where the source root would be. */
  objects: Object3D[];
}

const BATCHABLE_MATERIALS = new Set([
  'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial',
  'MeshPhongMaterial', 'MeshBasicMaterial', 'MeshMatcapMaterial', 'MeshToonMaterial',
]);

function batchable(mesh: Mesh): boolean {
  if ((mesh as { isInstancedMesh?: boolean }).isInstancedMesh
    || (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh) return false;
  if (mesh.userData.noBatch) return false;
  const mat = mesh.material;
  if (Array.isArray(mat) || !BATCHABLE_MATERIALS.has(mat.type)) return false;
  if (mat.clippingPlanes && mat.clippingPlanes.length > 0) return false;
  if (mesh.onBeforeRender !== Object3D.prototype.onBeforeRender) return false;
  const geo = mesh.geometry;
  if (!geo || !(geo as BufferGeometry).isBufferGeometry
    || (geo as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry) return false;
  if (!geo.attributes.position || !geo.attributes.normal) return false;
  if (Object.keys(geo.morphAttributes).length > 0) return false;
  if (geo.drawRange.start !== 0 || geo.drawRange.count !== Infinity) return false;
  return geo.attributes.position.count > 0;
}

function renderable(obj: Object3D): boolean {
  const o = obj as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return !!(o.isMesh || o.isLine || o.isPoints || o.isSprite);
}

/** Nearest element id on the object or its ancestors (below `root`). */
function elementIdOf(obj: Object3D, root: Object3D): string | null {
  let o: Object3D | null = obj;
  while (o && o !== root) {
    if (typeof o.userData.elementId === 'string') return o.userData.elementId;
    o = o.parent;
  }
  return null;
}

/**
 * Merge every visible batchable mesh under `source` into one mesh per
 * (material, shadow flags, render order, uv) group, and proxy the other
 * visible renderables. Output coordinates are relative to `source`.
 */
export function buildStaticBatch(source: Object3D): StaticBatch {
  source.updateWorldMatrix(true, true);
  const toSource = new Matrix4().copy(source.matrixWorld).invert();

  const groups = new Map<string, Group>();
  const objects: Object3D[] = [];
  const visit = (obj: Object3D) => {
    if (!obj.visible) return;
    if (renderable(obj)) {
      const matrix = new Matrix4().multiplyMatrices(toSource, obj.matrixWorld);
      const elementId = elementIdOf(obj, source);
      const mesh = obj as Mesh;
      if (mesh.isMesh && batchable(mesh)) {
        const mat = mesh.material as Material;
        const hasUv = !!mesh.geometry.attributes.uv && mesh.geometry.attributes.uv.itemSize === 2;
        const key = `${mat.uuid}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|${hasUv ? 1 : 0}`;
        let g = groups.get(key);
        if (!g) {
          g = { material: mat, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, renderOrder: mesh.renderOrder, hasUv, sources: [] };
          groups.set(key, g);
        }
        g.sources.push({ mesh, elementId, matrix });
      } else {
        // Shallow proxy: shares geometry + material, fixed at the source's transform.
        const proxy = obj.clone(false);
        proxy.matrixAutoUpdate = false;
        proxy.matrix.copy(matrix);
        matrix.decompose(proxy.position, proxy.quaternion, proxy.scale);
        if (elementId) proxy.userData = { ...proxy.userData, elementId };
        objects.push(proxy);
      }
    }
    for (const child of obj.children) visit(child);
  };
  for (const child of source.children) visit(child);

  for (const g of groups.values()) {
    const merged = mergeSources(g);
    merged.castShadow = g.castShadow;
    merged.receiveShadow = g.receiveShadow;
    merged.renderOrder = g.renderOrder;
    objects.push(merged);
  }
  return { objects };
}

/** Detach the batch's objects and free the merged geometry (proxies share theirs with the source). */
export function releaseStaticBatch(batch: StaticBatch): void {
  for (const o of batch.objects) {
    o.removeFromParent();
    if ((o.userData as Partial<BatchUserData>).batch) {
      const geo = (o as Mesh).geometry;
      (geo as unknown as { boundsTree?: unknown }).boundsTree = undefined;
      geo.dispose();
    }
  }
}

const _v = new Vector3();
const _n = new Vector3();
const _nm = new Matrix3();

function mergeSources(g: Group): Mesh {
  let vertexCount = 0, indexCount = 0;
  for (const s of g.sources) {
    const geo = s.mesh.geometry;
    vertexCount += geo.attributes.position.count;
    indexCount += geo.index ? geo.index.count : geo.attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = g.hasUv ? new Float32Array(vertexCount * 2) : null;
  const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const vertexStarts = new Uint32Array(g.sources.length);
  const ids: (string | null)[] = [];

  let vo = 0, io = 0;
  g.sources.forEach((s, si) => {
    const geo = s.mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const n = pos.count;
    vertexStarts[si] = vo;
    ids.push(s.elementId);
    _nm.getNormalMatrix(s.matrix);
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(s.matrix);
      position[(vo + i) * 3] = _v.x; position[(vo + i) * 3 + 1] = _v.y; position[(vo + i) * 3 + 2] = _v.z;
      _n.fromBufferAttribute(nor, i).applyMatrix3(_nm).normalize();
      normal[(vo + i) * 3] = _n.x; normal[(vo + i) * 3 + 1] = _n.y; normal[(vo + i) * 3 + 2] = _n.z;
    }
    if (uv) {
      const u = geo.attributes.uv;
      for (let i = 0; i < n; i++) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
    }
    // A mirroring transform flips the winding; swap two corners to keep faces front-facing.
    const flip = s.matrix.determinant() < 0;
    const src = geo.index;
    const count = src ? src.count : n;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = src ? src.getX(i) : i, b = src ? src.getX(i + 1) : i + 1, c = src ? src.getX(i + 2) : i + 2;
      index[io++] = vo + a;
      index[io++] = vo + (flip ? c : b);
      index[io++] = vo + (flip ? b : c);
    }
    vo += n;
  });

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(position, 3));
  geo.setAttribute('normal', new BufferAttribute(normal, 3));
  if (uv) geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(new BufferAttribute(index.subarray(0, io), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new Mesh(geo, g.material);
  const userData: BatchUserData = { batch: true, vertexStarts, ids };
  mesh.userData = userData as unknown as Record<string, unknown>;
  mesh.raycast = batchRaycast;
  return mesh;
}

/** BVH-accelerated raycast; the tree is built on the first hit test. */
function batchRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection[]): void {
  // (Cast: drei bundles its own three-mesh-bvh typing of `boundsTree`.)
  const geo = this.geometry as unknown as { boundsTree?: unknown };
  // `indirect` keeps the index buffer as built, so vertex ranges stay valid.
  if (!geo.boundsTree) geo.boundsTree = new MeshBVH(this.geometry, { indirect: true });
  acceleratedRaycast.call(this, raycaster, intersects);
}

/** Element id for a hit on a merged mesh, or undefined when `hit` isn't on one. */
export function resolveBatchElementId(hit: Intersection): string | null | undefined {
  const ud = hit.object.userData as Partial<BatchUserData>;
  if (!ud.batch || !ud.vertexStarts || !ud.ids || !hit.face) return undefined;
  const v = hit.face.a;
  const starts = ud.vertexStarts;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return ud.ids[lo];
}
