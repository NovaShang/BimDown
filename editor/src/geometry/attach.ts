/**
 * Roof solutions per element, and the surfaces a wall top can attach to
 * (Revit "Attach Top/Base"): a roof's underside or a slab's soffit, as convex
 * plan pieces each carrying the plane of its absolute elevation.
 */
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import {
  solveRoof, roofInputFor, triangulate, intersectConvex, subtractHoles, signedArea,
  type Plane, type P2, type RoofSolution,
} from './roofSolver.ts';

/** Tables a wall top can attach to. */
export const ATTACH_TARGET_TABLES = new Set(['roof', 'slab', 'structure_slab']);

const solutionCache = new WeakMap<object, RoofSolution>();

/** Roof planes for a roof element (cached per element object). */
export function roofSolution(el: PolygonElement): RoofSolution {
  let s = solutionCache.get(el);
  if (!s) {
    s = solveRoof(roofInputFor(el.vertices, el.attrs));
    solutionCache.set(el, s);
  }
  return s;
}

/** A convex plan piece of an attach surface; elevation z = plane(x, y), absolute. */
export interface AttachPiece { poly: P2[]; plane: Plane }

const DEFAULT_SLAB_THICKNESS = 0.2;

/** The underside a wall attaches to, absolute elevations. Null for other tables. */
export function attachSurface(target: CanonicalElement, levelElevation: number): AttachPiece[] | null {
  if (target.geometry !== 'polygon' || target.vertices.length < 3) return null;
  const base = parseFloat(target.attrs.base_offset || '0') || 0;
  if (target.tableName === 'roof') {
    const sol = roofSolution(target);
    const z0 = levelElevation + base;
    return sol.pieces.map(pc => {
      const p = sol.planes[pc.plane];
      return { poly: pc.poly, plane: { a: p.a, b: p.b, c: p.c + z0 } };
    });
  }
  if (target.tableName === 'slab' || target.tableName === 'structure_slab') {
    const t = parseFloat(target.attrs.thickness || '') || DEFAULT_SLAB_THICKNESS;
    const z = levelElevation + base - t;
    return triangulate(target.vertices).map(poly => ({ poly, plane: { a: 0, b: 0, c: z } }));
  }
  return null;
}

/** Resolve a wall's `top_attach_id` on its own level or any other one. */
export function resolveTopAttach(el: CanonicalElement, ctx: GeometryContext): AttachPiece[] | null {
  const id = el.attrs.top_attach_id;
  if (!id) return null;
  return ctx.memo(`attach-top:${id}`, () => {
    const local = ctx.elementById(id) ?? ctx.elementById(`${ctx.level.id}:${id}`);
    if (local && ATTACH_TARGET_TABLES.has(local.tableName)) return attachSurface(local, ctx.levelElevation);
    const entry = ctx.crossLevel?.find(id, ctx.level.id);
    if (entry && ATTACH_TARGET_TABLES.has(entry.el.tableName)) return attachSurface(entry.el, entry.elevation);
    return null;
  });
}

/** One piece of an attached wall's footprint with the plane of its top (absolute z). */
export interface TopPiece { poly: P2[]; top: Plane }

/**
 * Split a wall footprint by the attach surface: under the surface the top
 * follows it, elsewhere the wall keeps its own top (`ownTop`, absolute).
 */
export function wallTopPieces(footprint: P2[], surface: AttachPiece[], ownTop: number): TopPiece[] {
  const own: Plane = { a: 0, b: 0, c: ownTop };
  const out: TopPiece[] = [];
  for (const tri of triangulate(footprint)) {
    for (const pc of surface) {
      const poly = intersectConvex(tri, pc.poly);
      if (poly.length >= 3 && Math.abs(signedArea(poly)) > 1e-8) out.push({ poly, top: pc.plane });
    }
    for (const rest of subtractHoles([{ poly: tri }], surface.map(pc => pc.poly))) {
      if (Math.abs(signedArea(rest.poly)) > 1e-8) out.push({ poly: rest.poly, top: own });
    }
  }
  return out;
}

/** Highest top elevation over the pieces' vertices. */
export function maxTop(pieces: TopPiece[]): number {
  let z = -Infinity;
  for (const pc of pieces) for (const p of pc.poly) z = Math.max(z, pc.top.a * p.x + pc.top.b * p.y + pc.top.c);
  return z;
}
