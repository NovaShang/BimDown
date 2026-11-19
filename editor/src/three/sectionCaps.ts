/**
 * Cut-face caps for clipped views (section box, section views).
 *
 * Clipping opens closed solids; a cap closes them again. For each clip plane
 * the visible model's triangles are sliced on the CPU: every straddling
 * triangle gives one oriented segment, segments chain into loops, loops are
 * split into outlines and holes by winding and triangulated in the plane.
 * The result is one fill mesh + one outline per plane, nudged a hair into the
 * kept side so the renderer's own clipping planes (crop / other box faces)
 * trim the caps exactly like the model. Works with any geometry layout:
 * plain meshes, instanced meshes and merged batches.
 */
import {
  BufferGeometry, Float32BufferAttribute, Matrix4, Plane, ShapeUtils, Vector2, Vector3, Box3,
  type InstancedMesh, type Material, type Mesh, type Object3D,
} from 'three';

export interface CapGeometry {
  /** Triangles of the cut faces (world space). */
  fill: Float32Array;
  /** Element id per fill triangle (for picking), '' when unknown. */
  triIds: string[];
  /** Line segments of the cut outlines (world space). */
  outline: Float32Array;
}

interface Seg { a: Vector3; b: Vector3; id: string }

const EPS_KEY = 1e4; // 0.1 mm quantisation for chaining segment ends

const key = (v: Vector3) => `${Math.round(v.x * EPS_KEY)},${Math.round(v.y * EPS_KEY)},${Math.round(v.z * EPS_KEY)}`;

function isSolidMaterial(m: Material | Material[]): boolean {
  const first = Array.isArray(m) ? m[0] : m;
  return !!first && !first.transparent && first.visible !== false;
}

function elementIdOf(o: Object3D): string {
  let cur: Object3D | null = o;
  while (cur) {
    if (cur.userData.elementId) return cur.userData.elementId as string;
    cur = cur.parent;
  }
  return '';
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();
const _n = new Vector3(), _e1 = new Vector3(), _e2 = new Vector3(), _dir = new Vector3();
const _box = new Box3();

/** Slice one triangle (world space); pushes an oriented segment when it straddles the plane. */
function sliceTriangle(a: Vector3, b: Vector3, c: Vector3, plane: Plane, id: string, out: Seg[]) {
  const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b), dc = plane.distanceToPoint(c);
  if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) return;
  const pts: Vector3[] = [];
  const edge = (p: Vector3, q: Vector3, dp: number, dq: number) => {
    if ((dp > 0) !== (dq > 0) && dp !== dq) {
      const t = dp / (dp - dq);
      pts.push(new Vector3().copy(p).lerp(q, t));
    }
  };
  edge(a, b, da, db); edge(b, c, db, dc); edge(c, a, dc, da);
  if (pts.length < 2) return;
  // Orient: along plane.normal × triangle normal, so loops wind consistently.
  _n.crossVectors(_e1.subVectors(b, a), _e2.subVectors(c, a));
  _dir.crossVectors(plane.normal, _n);
  let [p, q] = pts;
  if (_e1.subVectors(q, p).dot(_dir) < 0) [p, q] = [q, p];
  if (p.distanceToSquared(q) < 1e-12) return;
  out.push({ a: p, b: q, id });
}

/** Chain oriented segments into closed loops (open chains are dropped). */
function chainLoops(segs: Seg[]): { pts: Vector3[]; id: string }[] {
  const byStart = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = key(s.a);
    const arr = byStart.get(k);
    if (arr) arr.push(s); else byStart.set(k, [s]);
  }
  const used = new Set<Seg>();
  const loops: { pts: Vector3[]; id: string }[] = [];
  for (const s0 of segs) {
    if (used.has(s0)) continue;
    used.add(s0);
    const pts = [s0.a];
    let cur = s0;
    const startKey = key(s0.a);
    let closed = false;
    for (let guard = 0; guard < 100000; guard++) {
      const k = key(cur.b);
      if (k === startKey) { closed = true; break; }
      const next = byStart.get(k)?.find(s => !used.has(s));
      if (!next) break;
      used.add(next);
      pts.push(next.a);
      cur = next;
    }
    if (closed && pts.length >= 3) loops.push({ pts, id: s0.id });
  }
  return loops;
}

function area2D(p: Vector2[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x - p[i].x) * (p[j].y + p[i].y);
  return s / 2;
}

function pointInPolygon(pt: Vector2, poly: Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Cap geometry for `plane` from every visible solid mesh under `root`.
 * `offset`: distance the caps are moved into the kept half-space.
 */
export function computeCaps(root: Object3D, plane: Plane, offset = 1e-3): CapGeometry {
  root.updateWorldMatrix(true, true);
  const groups: Seg[][] = [];
  const m = new Matrix4(), mw = new Matrix4();

  root.traverseVisible(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position || !isSolidMaterial(mesh.material)) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const pos = geo.attributes.position;
    const index = geo.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const inst = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh) : null;
    const indexToId = mesh.userData.indexToId as string[] | undefined;
    const baseId = elementIdOf(mesh);
    const count = inst ? inst.count : 1;
    for (let k = 0; k < count; k++) {
      if (inst) { inst.getMatrixAt(k, m); mw.multiplyMatrices(mesh.matrixWorld, m); } else mw.copy(mesh.matrixWorld);
      if (geo.boundingBox && !plane.intersectsBox(_box.copy(geo.boundingBox).applyMatrix4(mw))) continue;
      const id = inst ? (indexToId?.[k] ?? baseId) : baseId;
      const segs: Seg[] = [];
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        _a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
        _b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
        _c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
        sliceTriangle(_a, _b, _c, plane, id, segs);
      }
      if (segs.length) groups.push(segs);
    }
  });

  // 2D basis in the plane.
  const n = plane.normal;
  const u = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0).cross(n).normalize() : new Vector3(1, 0, 0).cross(n).normalize();
  const v = new Vector3().crossVectors(n, u);
  const origin = n.clone().multiplyScalar(-plane.constant);
  const to2D = (p: Vector3) => { const d = _e1.subVectors(p, origin); return new Vector2(d.dot(u), d.dot(v)); };
  const lift = (q: Vector2) => origin.clone().addScaledVector(u, q.x).addScaledVector(v, q.y).addScaledVector(n, offset);

  const fill: number[] = [];
  const triIds: string[] = [];
  const outline: number[] = [];
  // Per source mesh / instance: chaining never jumps between touching solids and
  // a mirrored transform (flipped winding) only affects its own loops.
  for (const segs of groups) {
    const loops = chainLoops(segs);
    const shapes = loops.map(l => {
      const pts = l.pts.map(to2D);
      return { ...l, p2: pts, area: area2D(pts) };
    });
    // Winding: outlines share the sign of the largest loop; opposite sign = hole.
    let outerSign = 1, maxAbs = 0;
    for (const s of shapes) if (Math.abs(s.area) > maxAbs) { maxAbs = Math.abs(s.area); outerSign = Math.sign(s.area) || 1; }
    const outers = shapes.filter(s => Math.sign(s.area) === outerSign && Math.abs(s.area) > 1e-8);
    const holes = shapes.filter(s => Math.sign(s.area) !== outerSign && Math.abs(s.area) > 1e-8);
    const holesOf = new Map<typeof outers[number], Vector2[][]>();
    for (const h of holes) {
      let best: typeof outers[number] | null = null;
      for (const o of outers) {
        if (pointInPolygon(h.p2[0], o.p2) && (!best || Math.abs(o.area) < Math.abs(best.area))) best = o;
      }
      if (best) {
        const arr = holesOf.get(best) ?? [];
        arr.push(h.p2);
        holesOf.set(best, arr);
      }
    }

    for (const o of outers) {
      const hs = holesOf.get(o) ?? [];
      const all = [o.p2, ...hs].flat();
      let faces: number[][];
      try { faces = ShapeUtils.triangulateShape(o.p2, hs); } catch { continue; }
      for (const f of faces) {
        for (const idx of f) { const w = lift(all[idx]); fill.push(w.x, w.y, w.z); }
        triIds.push(o.id);
      }
    }
    for (const s of shapes) {
      const pts = s.p2.map(lift);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        outline.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }
  return { fill: new Float32Array(fill), triIds, outline: new Float32Array(outline) };
}

export function capBufferGeometry(data: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data, 3));
  return g;
}
