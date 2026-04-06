import type { BimPrimitive, SurfacePrimitive } from '../primitives/types.ts';
import { applyMiter } from './miter.ts';
import { expandComposites } from './expandComposite.ts';
import { applyTrim } from './trim.ts';

export interface ResolveContext {
  /** Extra surface primitives used as trim sources (e.g. roofs for wall-roof trim).
   *  These are NOT added to the output — only consulted during the trim phase. */
  trimSources?: SurfacePrimitive[];
}

/**
 * Runs the full resolve pipeline on builder-produced primitives.
 * Phases:
 *   1. Expand composites → base primitives
 *   2. Miter: adjust footprints of surfaces sharing a miterGroup
 *   3. Trim: cut wall tops by overlapping roof surfaces
 *   4. CSG openings happen in generateGeometry (per-primitive)
 */
export function resolvePrimitives(
  primitives: BimPrimitive[],
  ctx: ResolveContext = {},
): BimPrimitive[] {
  let prims = expandComposites(primitives);

  const surfaces: SurfacePrimitive[] = [];
  const others: BimPrimitive[] = [];
  for (const p of prims) {
    if (p.kind === 'surface') surfaces.push(p);
    else others.push(p);
  }

  let resolvedSurfaces = applyMiter(surfaces);
  if (ctx.trimSources && ctx.trimSources.length > 0) {
    resolvedSurfaces = applyTrim(resolvedSurfaces, ctx.trimSources);
  }

  prims = [...resolvedSurfaces, ...others];
  return prims;
}
