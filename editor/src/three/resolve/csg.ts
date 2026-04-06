import { Shape, ExtrudeGeometry, BoxGeometry, CylinderGeometry, Matrix4, type BufferGeometry } from 'three';
import { SUBTRACTION, Evaluator, Brush } from 'three-bvh-csg';
import type { SurfacePrimitive, OpeningDecl } from '../primitives/types.ts';

const csgEvaluator = new Evaluator();

/**
 * Apply all openings to a host surface geometry via CSG subtraction.
 * Handles both ParametricOpening (axis-aligned along host, e.g. wall openings)
 * and PolygonOpening (arbitrary 2D polygon in world XY, e.g. slab openings).
 *
 * Phase 3: supports 'rect' parametric shape and polygon openings.
 * Phase 7: adds 'round' and 'arch' parametric shapes.
 */
export function applyOpenings(
  hostGeo: BufferGeometry,
  prim: SurfacePrimitive,
): BufferGeometry {
  if (!prim.openings || prim.openings.length === 0) return hostGeo;

  let brush = new Brush(hostGeo);

  for (const op of prim.openings) {
    const cutBrush = buildOpeningBrush(op, prim);
    if (!cutBrush) continue;

    try {
      brush = csgEvaluator.evaluate(brush, cutBrush, SUBTRACTION);
    } catch {
      // CSG can fail on degenerate geometry — skip this opening
    }
    cutBrush.geometry.dispose();
  }

  return brush.geometry;
}

function buildOpeningBrush(
  op: OpeningDecl,
  prim: SurfacePrimitive,
): Brush | null {
  if (op.kind === 'polygon') {
    return buildPolygonBrush(op.vertices, prim);
  }
  // kind === 'parametric'
  if (!prim.miterMeta) return null;
  return buildParametricBrush(op, prim);
}

/** Polygon opening: extrude opening footprint through full host thickness. */
function buildPolygonBrush(
  vertices: { x: number; y: number }[],
  prim: SurfacePrimitive,
): Brush | null {
  if (vertices.length < 3) return null;

  const shape = new Shape();
  shape.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) {
    shape.lineTo(vertices[i].x, vertices[i].y);
  }
  shape.closePath();

  const h = prim.height;
  const cutGeo = new ExtrudeGeometry(shape, { depth: h * 2, bevelEnabled: false });
  cutGeo.rotateX(-Math.PI / 2);
  cutGeo.translate(0, prim.origin.y - h * 0.5, 0);

  return new Brush(cutGeo);
}

/**
 * Parametric opening: axis-aligned shape on the host's primary axis.
 * Used by walls for doors/windows/openings. Shape: rect | round | arch.
 * Position is distance from host start along the wall direction.
 */
function buildParametricBrush(
  op: Extract<OpeningDecl, { kind: 'parametric' }>,
  prim: SurfacePrimitive,
): Brush | null {
  const meta = prim.miterMeta!;
  const dx = meta.endX - meta.startX;
  const dy = meta.endY - meta.startY;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 0.001) return null;

  const ux = dx / wallLen;
  const uy = dy / wallLen;

  // Opening center along wall
  const tCenter = op.position + op.width / 2;
  const cx = meta.startX + ux * tCenter;
  const cy = meta.startY + uy * tCenter;

  // 3D center: SVG y → world z (negated)
  const worldX = cx;
  const worldZ = -cy;
  const worldY = prim.origin.y + op.sillHeight + op.height / 2;

  // 2x wall thickness to ensure full cut-through
  const thickness = meta.halfWidth * 4;
  const angle = Math.atan2(dy, dx);

  let cutGeo: BufferGeometry;
  switch (op.shape) {
    case 'round': {
      // Circular opening: cylinder with axis along wall thickness (world +Z after rotation).
      // CylinderGeometry default axis is +Y; rotate to align with wall thickness direction.
      const radius = Math.min(op.width, op.height) / 2;
      const cyl = new CylinderGeometry(radius, radius, thickness, 24);
      cyl.rotateX(Math.PI / 2); // cylinder axis now along local +Z
      cutGeo = cyl;
      break;
    }
    case 'arch': {
      // Rect bottom + half-circle top. Shape in XY plane (X=width, Y=height), extruded along Z (thickness).
      const halfW = op.width / 2;
      const archH = op.archRadius ?? halfW;
      const rectH = Math.max(op.height - archH, 0);
      const shape = new Shape();
      shape.moveTo(-halfW, -op.height / 2);
      shape.lineTo(halfW, -op.height / 2);
      shape.lineTo(halfW, -op.height / 2 + rectH);
      shape.absarc(0, -op.height / 2 + rectH, halfW, 0, Math.PI, false);
      shape.lineTo(-halfW, -op.height / 2);
      shape.closePath();
      cutGeo = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
      cutGeo.translate(0, 0, -thickness / 2);
      break;
    }
    case 'rect':
    default:
      cutGeo = new BoxGeometry(op.width, op.height, thickness);
      break;
  }

  const m = new Matrix4().makeRotationY(angle).setPosition(worldX, worldY, worldZ);
  cutGeo.applyMatrix4(m);
  return new Brush(cutGeo);
}
