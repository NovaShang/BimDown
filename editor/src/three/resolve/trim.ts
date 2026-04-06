import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import { SUBTRACTION, Evaluator, Brush } from 'three-bvh-csg';
import type { SurfacePrimitive, Vec2 } from '../primitives/types.ts';

const evaluator = new Evaluator();
const HIGH_Y = 1000;

/**
 * For each wall-like primitive that overlaps a roof footprint, precompute
 * its trimmed geometry (wall extrusion with the "above roof" volume removed)
 * and attach it as `prebuilt` so generateGeometry uses it directly.
 *
 * This runs after miter (footprints are final) and before opening CSG.
 */
export function applyTrim(
  primitives: SurfacePrimitive[],
  trimSources: SurfacePrimitive[],
): SurfacePrimitive[] {
  const roofs = trimSources.filter(p => p.tableName === 'roof');
  if (roofs.length === 0) return primitives;

  // Precompute trim solid per roof (union of "above roof surface" volumes)
  const trimSolids = roofs.map(r => buildTrimSolid(r)).filter((x): x is BufferGeometry => x != null);
  if (trimSolids.length === 0) return primitives;

  const result: SurfacePrimitive[] = [];
  for (const prim of primitives) {
    if (!isTrimmable(prim)) {
      result.push(prim);
      continue;
    }

    // AABB check: does wall footprint overlap any roof footprint?
    const wallBB = footprintAABB(prim.footprint);
    const relevantSolids: BufferGeometry[] = [];
    for (let i = 0; i < roofs.length; i++) {
      const roofBB = footprintAABB(roofs[i].footprint);
      if (aabbOverlap(wallBB, roofBB)) relevantSolids.push(trimSolids[i]);
    }
    if (relevantSolids.length === 0) {
      result.push(prim);
      continue;
    }

    // Extrude wall footprint, then subtract each trim solid
    const wallGeo = extrudeWall(prim);
    if (!wallGeo) {
      result.push(prim);
      continue;
    }

    let brush = new Brush(wallGeo);
    for (const trimSolid of relevantSolids) {
      const trimBrush = new Brush(trimSolid);
      try {
        brush = evaluator.evaluate(brush, trimBrush, SUBTRACTION);
      } catch {
        // CSG failure — keep original
      }
    }
    result.push({ ...prim, prebuilt: brush.geometry });
  }

  return result;
}

function isTrimmable(prim: SurfacePrimitive): boolean {
  // Only walls get trimmed by roofs (for now)
  return prim.tableName === 'wall' || prim.tableName === 'structure_wall';
}

function extrudeWall(prim: SurfacePrimitive): BufferGeometry | null {
  if (prim.footprint.length < 3) return null;
  const shape = new Shape();
  shape.moveTo(prim.footprint[0].x, prim.footprint[0].y);
  for (let i = 1; i < prim.footprint.length; i++) {
    shape.lineTo(prim.footprint[i].x, prim.footprint[i].y);
  }
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: prim.height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(prim.origin.x, prim.origin.y, prim.origin.z);
  return geo;
}

/**
 * Build a "volume above roof surface" solid:
 * extrude roof footprint from baseY to HIGH_Y, then subtract the roof's solid geometry.
 * Result: column of air above the (possibly sloped) roof surface.
 */
function buildTrimSolid(roof: SurfacePrimitive): BufferGeometry | null {
  if (roof.footprint.length < 3 || !roof.prebuilt) return null;

  const shape = new Shape();
  shape.moveTo(roof.footprint[0].x, roof.footprint[0].y);
  for (let i = 1; i < roof.footprint.length; i++) {
    shape.lineTo(roof.footprint[i].x, roof.footprint[i].y);
  }
  shape.closePath();

  const prismDepth = HIGH_Y - roof.origin.y;
  if (prismDepth <= 0) return null;
  const prismGeo = new ExtrudeGeometry(shape, { depth: prismDepth, bevelEnabled: false });
  prismGeo.rotateX(-Math.PI / 2);
  prismGeo.translate(0, roof.origin.y, 0);

  try {
    const prismBrush = new Brush(prismGeo);
    const roofBrush = new Brush(roof.prebuilt);
    const result = evaluator.evaluate(prismBrush, roofBrush, SUBTRACTION);
    prismGeo.dispose();
    return result.geometry;
  } catch {
    prismGeo.dispose();
    return null;
  }
}

interface AABB { minX: number; minY: number; maxX: number; maxY: number }

function footprintAABB(pts: Vec2[]): AABB {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
