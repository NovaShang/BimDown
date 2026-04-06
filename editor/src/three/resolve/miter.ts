import type { SurfacePrimitive } from '../primitives/types.ts';
import { computeCornerAdjustments, type WallSegment } from '../../utils/wallMiter.ts';

/**
 * Apply miter joins to SurfacePrimitives that share a miterGroup.
 * Rewrites each primitive's footprint based on computed corner adjustments
 * at shared endpoints and T-junctions.
 *
 * Reuses wallMiter.ts's computeCornerAdjustments as the core 2D geometry solver.
 * Only primitives with both miterGroup and miterMeta set participate.
 */
export function applyMiter(primitives: SurfacePrimitive[]): SurfacePrimitive[] {
  // Group primitives by miterGroup
  const groups = new Map<string, SurfacePrimitive[]>();
  for (const prim of primitives) {
    if (!prim.miterGroup || !prim.miterMeta) continue;
    const list = groups.get(prim.miterGroup) ?? [];
    list.push(prim);
    groups.set(prim.miterGroup, list);
  }

  if (groups.size === 0) return primitives;

  // For each group, compute adjustments and rewrite footprints
  const updated = new Map<string, SurfacePrimitive>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const segments: WallSegment[] = group.map(p => ({
      id: p.id,
      x1: p.miterMeta!.startX, y1: p.miterMeta!.startY,
      x2: p.miterMeta!.endX,   y2: p.miterMeta!.endY,
      halfWidth: p.miterMeta!.halfWidth,
      fill: '',
    }));

    const { adjustments } = computeCornerAdjustments(segments);

    for (const prim of group) {
      const meta = prim.miterMeta!;
      const hw = meta.halfWidth;
      const dx = meta.endX - meta.startX;
      const dy = meta.endY - meta.startY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) continue;
      const nx = -dy / len;
      const ny = dx / len;

      // Default corners (matching builder's initial footprint)
      let p1 = { x: meta.startX + nx * hw, y: meta.startY + ny * hw };
      let p2 = { x: meta.endX + nx * hw,   y: meta.endY + ny * hw };
      let p3 = { x: meta.endX - nx * hw,   y: meta.endY - ny * hw };
      let p4 = { x: meta.startX - nx * hw, y: meta.startY - ny * hw };

      const startAdj = adjustments.get(`${prim.id}:start`);
      if (startAdj) {
        p1 = startAdj.left;
        p4 = startAdj.right;
      }
      const endAdj = adjustments.get(`${prim.id}:end`);
      if (endAdj) {
        p2 = endAdj.right;
        p3 = endAdj.left;
      }

      updated.set(prim.id, { ...prim, footprint: [p1, p2, p3, p4] });
    }
  }

  // Return primitives with updated footprints
  return primitives.map(p => updated.get(p.id) ?? p);
}
