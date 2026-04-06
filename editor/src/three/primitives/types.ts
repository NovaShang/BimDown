import type { Shape } from 'three';
import type { BufferGeometry } from 'three';
import type { BimMaterial } from '../utils/bimMaterials.ts';

/**
 * Geometric primitives produced by builders from CanonicalElements.
 * Builders declare geometry intent; the resolve pipeline handles inter-primitive
 * interactions (miter, trim, CSG) and generates BufferGeometry for rendering.
 */

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

/**
 * Shape2D: either a parametric profile spec (resolved via profiles.createProfile)
 * or a pre-built THREE.Shape. Used as cross-sections for paths and columns.
 */
export type Shape2D =
  | { kind: 'rect'; width: number; depth: number }
  | { kind: 'round'; radius: number }
  | { kind: 'i'; width: number; depth: number; flange: number; web: number }
  | { kind: 't'; width: number; depth: number; flange: number; web: number }
  | { kind: 'l'; width: number; depth: number; thickness: number }
  | { kind: 'c'; width: number; depth: number; flange: number; web: number }
  | { kind: 'cross'; width: number; depth: number; thickness: number }
  | { kind: 'shape'; shape: Shape };

/**
 * Declares a hole to be cut from a host surface.
 * Two variants:
 *  - parametric: axis-aligned along host (doors/windows/openings on walls)
 *  - polygon: 2D polygon in world coords (openings in slabs)
 */
/**
 * Miter metadata for line-like surface primitives (walls).
 * The solver uses this to compute corner adjustments; the resolved footprint
 * overrides the builder's initial corners.
 */
export interface MiterMeta {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  halfWidth: number;
  arc?: import('../../utils/arcMath.ts').ArcParams;
}

export type OpeningDecl = ParametricOpening | PolygonOpening;

export interface ParametricOpening {
  kind: 'parametric';
  id: string;
  shape: 'rect' | 'round' | 'arch';
  position: number;       // distance in meters along host axis from host start
  width: number;          // opening width in meters
  height: number;         // opening height in meters
  sillHeight: number;     // elevation of opening bottom relative to host base
  archRadius?: number;    // for 'arch' shape: curve radius (defaults to width/2)
}

export interface PolygonOpening {
  kind: 'polygon';
  id: string;
  vertices: Vec2[];       // SVG-space XY coords matching host footprint system
}

/**
 * Surface: a 2D footprint extruded along a direction, with optional thickness.
 * Used for walls, slabs, roofs, ceilings, spaces, glass panels.
 */
export interface SurfacePrimitive {
  kind: 'surface';
  id: string;
  elementId: string;         // source CanonicalElement id (may be prefixed: "levelId:rawId")
  tableName: string;
  footprint: Vec2[];         // 2D polygon in world XZ plane
  extrudeDirection: Vec3;    // unit vector; (0,1,0) vertical, angled for roofs
  height: number;            // extrusion distance along extrudeDirection
  origin: Vec3;              // world-space base point (Y is elevation)
  material: BimMaterial;
  wireframe?: boolean;       // render as edges only (for spaces)
  miterGroup?: string;       // same-group surfaces get miter-joined
  miterMeta?: MiterMeta;     // axis info for miter solver (walls: endpoints + halfWidth)
  trimBy?: string[];         // primitive ids whose planes trim this surface
  openings?: OpeningDecl[];  // holes to cut via CSG
  // Optional: pre-built geometry (e.g. for pitched roofs, computed by roofGeometry.ts).
  // If present, resolve pipeline skips default extrusion for this primitive.
  prebuilt?: BufferGeometry;
}

/**
 * Path: a 2D cross-section swept along a 3D polyline.
 * Used for beams, braces, pipes, ducts, conduits, mullions, handrails.
 */
export interface PathPrimitive {
  kind: 'path';
  id: string;
  elementId: string;
  tableName: string;
  profile: Shape2D;
  path: Vec3[];              // 3D polyline (at minimum 2 points)
  material: BimMaterial;
  endCondition?: 'flat' | 'miter';
}

/**
 * Instance: a single positioned object.
 * Source can be a profile extrusion, loaded mesh, pre-built geometry, or unit box.
 * Used for columns, furniture, equipment, door panels, stair treads, balusters.
 */
export interface InstancePrimitive {
  kind: 'instance';
  id: string;
  elementId: string;
  tableName: string;
  position: Vec3;
  rotation: Vec3;            // Euler angles (radians, XYZ order)
  scale: Vec3;
  source:
    | { type: 'profile'; profile: Shape2D; height: number }
    | { type: 'mesh'; url: string }
    | { type: 'geometry'; geometry: BufferGeometry }
    | { type: 'box' };
  material: BimMaterial;
}

/**
 * Composite: a parametric rule that expands into other primitives.
 * Used for curtain walls, stairs, railings.
 */
export interface CompositePrimitive {
  kind: 'composite';
  id: string;
  elementId: string;
  tableName: string;
  rule: CurtainWallRule | StairRule | RailingRule;
  material: BimMaterial;
}

export interface CurtainWallRule {
  type: 'curtain_wall';
  start: Vec2;
  end: Vec2;
  baseY: number;
  height: number;
  uGridCount: number;        // horizontal divisions along wall length
  vGridCount: number;        // vertical divisions
  uSpacings?: number[];      // custom horizontal spacings (overrides uGridCount)
  vSpacings?: number[];      // custom vertical spacings (overrides vGridCount)
  mullionSize: number;       // mullion cross-section edge length (square)
  panelThickness: number;
  frameMaterial: BimMaterial;
  panelMaterial: BimMaterial;
}

export interface StairRule {
  type: 'stair';
  start: Vec2;
  end: Vec2;
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  material: BimMaterial;
}

export interface RailingRule {
  type: 'railing';
  path: Vec3[];              // railing centerline
  height: number;
  balusterSpacing: number;   // distance between balusters in meters
  balusterProfile: Shape2D;
  handrailProfile: Shape2D;
  material: BimMaterial;
}

export type BimPrimitive =
  | SurfacePrimitive
  | PathPrimitive
  | InstancePrimitive
  | CompositePrimitive;
