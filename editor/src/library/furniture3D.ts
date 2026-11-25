/**
 * Library massing → one merged, vertex-coloured BufferGeometry per (family,
 * variant, size, mirror). Shared by every instance with the same parameters
 * and drawn with one shared material, so a furnished floor is cheap to render
 * and easy to batch. Local frame: X right, Y back, Z up → three (x, z, -y).
 */
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute,
  IcosahedronGeometry, Mesh, MeshStandardMaterial,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  furnitureMass, MASS_COLORS, resolveFurniture, type MassColor, type MassPart, type ResolvedFurniture,
} from './furnitureLibrary.ts';
import type { CanonicalElement, PointElement } from '../model/elements.ts';

const COLORS = new Map<MassColor, Color>();
function color(c: MassColor): Color {
  let col = COLORS.get(c);
  if (!col) { col = new Color(MASS_COLORS[c]); COLORS.set(c, col); }
  return col;
}

/** One mass part as a non-indexed, vertex-coloured geometry (local frame, three axes). */
export function furniturePartGeometry(m: MassPart): BufferGeometry {
  let g: BufferGeometry;
  switch (m.k) {
    case 'box':
      g = new BoxGeometry(m.w, m.h, m.d);
      g.translate(m.x, m.z + m.h / 2, -m.y);
      break;
    case 'cyl': {
      const seg = m.seg ?? 12;
      g = new CylinderGeometry(m.rx * (m.top ?? 1), m.rx, m.h, seg, 1, false);
      if (m.ry !== m.rx) g.scale(1, 1, m.ry / m.rx);
      g.translate(m.x, m.z + m.h / 2, -m.y);
      break;
    }
    case 'sph':
      g = new IcosahedronGeometry(1, 1);
      g.scale(m.rx, m.rz, m.ry);
      g.translate(m.x, m.z, -m.y);
      break;
  }
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.deleteAttribute('uv');
  if (m.k === 'sph') flat.computeVertexNormals();
  const n = flat.getAttribute('position').count;
  const col = color(m.c);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = col.r; rgb[i * 3 + 1] = col.g; rgb[i * 3 + 2] = col.b; }
  flat.setAttribute('color', new Float32BufferAttribute(rgb, 3));
  return flat;
}

/** Merge the parts of one resolved component (local frame, origin at the base centre). */
export function buildFurnitureGeometry(r: ResolvedFurniture): BufferGeometry {
  const parts = furnitureMass(r).map(furniturePartGeometry);
  const merged = mergeGeometries(parts, false) ?? new BufferGeometry();
  for (const p of parts) p.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

const CACHE = new Map<string, BufferGeometry>();
const CACHE_MAX = 400;

export function furnitureGeometryKey(r: ResolvedFurniture): string {
  const p = r.params;
  return `${r.family.id}|${p.variant}|${p.w.toFixed(3)}|${p.d.toFixed(3)}|${p.h.toFixed(3)}|${r.mirror ? 1 : 0}|${r.upm}`;
}

/** Cached shared geometry: instances with equal parameters share one buffer. */
export function furnitureGeometry(r: ResolvedFurniture): BufferGeometry {
  const key = furnitureGeometryKey(r);
  let g = CACHE.get(key);
  if (g) {
    // LRU touch
    CACHE.delete(key); CACHE.set(key, g);
    return g;
  }
  g = buildFurnitureGeometry(r);
  CACHE.set(key, g);
  if (CACHE.size > CACHE_MAX) {
    // Evicted geometries may still be on screen: let three keep them; the
    // GPU buffer is released when the mesh unmounts and the object is GC'd.
    const oldest = CACHE.keys().next().value!;
    CACHE.delete(oldest);
  }
  return g;
}

let sharedMaterial: MeshStandardMaterial | null = null;
/** One material for every furniture mesh (colours live in the vertices). */
export function furnitureMaterial(): MeshStandardMaterial {
  if (!sharedMaterial) sharedMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });
  return sharedMaterial;
}

/** A standalone mesh for export (glTF): world-placed, named `furniture:<id>`. */
export function furnitureObject3D(el: CanonicalElement, levelElevation: number, upm = 1): Mesh | null {
  if (el.tableName !== 'furniture' || el.geometry !== 'point') return null;
  const p = el as PointElement;
  const r = resolveFurniture(p.attrs, upm);
  const mesh = new Mesh(buildFurnitureGeometry(r), furnitureMaterial());
  mesh.position.set(p.position.x, levelElevation + (parseFloat(p.attrs.base_offset || '0') || 0), -p.position.y);
  mesh.rotation.y = ((parseFloat(p.attrs.rotation || '0') || 0) * Math.PI) / 180;
  mesh.name = `furniture:${p.id}`;
  mesh.userData = { family: r.family.id, variant: r.params.variant, category: r.family.category };
  return mesh;
}
