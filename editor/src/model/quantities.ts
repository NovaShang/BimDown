/**
 * Per-element quantities for schedules / take-off: length, area, section
 * area, height and volume in project units (m, m², m³ for metre projects).
 * Pure: needs only the element and the level elevations.
 *
 *   structure_column / column  section area × height (top level − base)
 *   beam / brace               section area × 3D length
 *   wall / structure_wall      length × thickness × height
 *   slab / structure_slab      (outline − inner rings) area × thickness
 *   foundation                 pad w × l × t, pile π r² × length, strip length × w × t,
 *                              raft / pile cap area × t
 * Hosted openings are not deducted (doors, windows, slab openings).
 */
import type { CanonicalElement, LineElement, Point, PointElement, PolygonElement, SpatialLineElement } from './elements.ts';
import { resolveSection } from '../families/sections/index.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { foundationKind } from '../elements/foundation.tsx';

export interface ElementQuantities {
  /** Plan length (lines) or 3D length (spatial framing). */
  length?: number;
  /** Plan area (polygons, net of inner rings) or plan footprint (points). */
  area?: number;
  /** Cross-section area of a framing member or column. */
  sectionArea?: number;
  height?: number;
  volume?: number;
}

const num = (v: string | undefined, fallback = 0) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/** Shoelace area (absolute) of a ring. */
export function ringArea(vs: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Cross-section area from the element's `shape` + section params. */
export function sectionArea(attrs: Record<string, string>, fallbackW = 0.3, fallbackD = 0.3): number {
  const section = resolveSection(attrs.shape || 'rect', {
    ...attrs,
    size_x: attrs.size_x || String(fallbackW),
    size_y: attrs.size_y || String(fallbackD),
  });
  if (section.family.id === 'round') {
    const r = section.family.bbox(section.params).w / 2;
    return Math.PI * r * r;
  }
  return ringArea(section.family.outline2D(section.params));
}

function polygonNetArea(el: PolygonElement): number {
  let a = ringArea(el.vertices);
  for (const h of el.holes ?? []) a -= ringArea(h);
  return Math.max(0, a);
}

/**
 * Quantities of one element on a level at `levelElevation`. Returns `{}` for
 * tables without a volumetric meaning (spaces, grids, MEP).
 */
export function elementQuantities(
  el: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): ElementQuantities {
  const t = el.tableName;
  const a = el.attrs;

  if ((t === 'structure_column' || t === 'column') && el.geometry === 'point') {
    const p = el as PointElement;
    const { height } = resolveHeight(a, levelElevation, levelElevations, 3);
    const s = sectionArea(a, p.width, p.height);
    return { sectionArea: s, height, area: s, volume: s * height };
  }

  if ((t === 'beam' || t === 'brace') && (el.geometry === 'line' || el.geometry === 'spatial_line')) {
    const ln = el as LineElement;
    const dz = el.geometry === 'spatial_line'
      ? (el as SpatialLineElement).endZ - (el as SpatialLineElement).startZ
      : num(a.end_z) - num(a.start_z);
    const length = Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y, dz);
    const s = sectionArea(a);
    return { length, sectionArea: s, volume: s * length };
  }

  if ((t === 'wall' || t === 'structure_wall') && el.geometry === 'line') {
    const ln = el as LineElement;
    const length = Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y);
    const thickness = num(a.thickness, ln.strokeWidth);
    const { height } = resolveHeight(a, levelElevation, levelElevations, 3);
    return { length, height, area: length * height, volume: length * thickness * height };
  }

  if ((t === 'slab' || t === 'structure_slab') && el.geometry === 'polygon') {
    const area = polygonNetArea(el as PolygonElement);
    return { area, volume: area * num(a.thickness, 0.2) };
  }

  if (t === 'foundation') {
    const thickness = num(a.thickness, 0.4);
    if (el.geometry === 'point') {
      const p = el as PointElement;
      const w = num(a.width, p.width);
      const lenAttr = num(a.length, NaN);
      const round = foundationKind(el) === 'pile' && !Number.isFinite(lenAttr);
      const area = round ? Math.PI * (w / 2) ** 2 : w * (Number.isFinite(lenAttr) ? lenAttr : p.height || w);
      return { area, height: thickness, volume: area * thickness };
    }
    if (el.geometry === 'line' || el.geometry === 'spatial_line') {
      const ln = el as LineElement;
      const length = Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y);
      const width = num(a.width, ln.strokeWidth);
      return { length, area: length * width, volume: length * width * thickness };
    }
    if (el.geometry === 'polygon') {
      const area = polygonNetArea(el as PolygonElement);
      return { area, volume: area * thickness };
    }
  }

  return {};
}
