/**
 * Element quantities for schedules and the properties panel. Same rules as
 * `bimdown build` / `bimdown query`:
 *   - length: centre line (arc length for curved walls; 3D length for spatial lines)
 *   - height: top level elevation + top_offset − (base level elevation + base_offset),
 *     top level defaulting to the next level up (empty when there is none)
 *   - room area / perimeter: the boundary derived from wall centre lines of the
 *     level plus global/ walls (space.geojson)
 *   - polygon area: shoelace of the outline
 * Wall area is net of hosted doors / windows / openings (as in Revit); gross
 * area is reported alongside.
 * Structural take-off (columns, framing, structural walls, slabs, foundations)
 * uses model/quantities.ts: the same volume as `bimdown query` (section
 * profiles, slab holes deducted, foundation kinds).
 */
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import type { Level, ProjectData } from '../types.ts';
import { parseFloorLayers, parseLayer } from '../model/parse.ts';
import { arcLength } from '../geometry/arc.ts';
import { boundaryWalls, roomPolygon, polygonArea, polygonPerimeter } from '../annotation/rooms.ts';
import { isAnnotationTable } from '../annotation/model.ts';
import { elementQuantities as structuralQuantities } from '../model/quantities.ts';

export interface ElementQuantities {
  length?: number;
  height?: number;
  area?: number;
  gross_area?: number;
  volume?: number;
  perimeter?: number;
}

export interface LevelElements {
  level: Level;
  elements: CanonicalElement[];
}

const VERTICAL = new Set(['wall', 'structure_wall', 'curtain_wall', 'column', 'structure_column']);
const SLABS = new Set(['slab', 'structure_slab', 'ceiling', 'roof', 'foundation']);
const STRUCTURAL = new Set(['structure_column', 'column', 'beam', 'brace', 'structure_wall', 'structure_slab', 'slab', 'foundation']);

/** Every level's elements: the live document for `liveLevel`, parsed files for the rest; global/ elements land on their base level. */
export function collectLevels(project: ProjectData, liveLevel?: string, live?: Map<string, CanonicalElement>): { levels: LevelElements[]; global: CanonicalElement[] } {
  const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
  const global: CanonicalElement[] = [];
  for (const gl of project.globalLayers) global.push(...parseLayer(gl));
  const levels = sorted.map(level => {
    const elements = level.id === liveLevel && live
      ? [...live.values()]
      : parseFloorLayers(project.floors.get(level.id)?.layers ?? []);
    return { level, elements: elements.filter(e => e.tableName !== 'grid' && !isAnnotationTable(e.tableName)) };
  });
  return { levels, global };
}

export function lineLength(el: CanonicalElement): number {
  if (el.geometry === 'line') {
    const ln = el as LineElement;
    return ln.arc ? arcLength(ln.start, ln.end, ln.arc) : Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y);
  }
  if (el.geometry === 'spatial_line') {
    const sp = el as SpatialLineElement;
    const plan = sp.arc ? arcLength(sp.start, sp.end, sp.arc) : Math.hypot(sp.end.x - sp.start.x, sp.end.y - sp.start.y);
    return Math.hypot(plan, sp.endZ - sp.startZ);
  }
  return 0;
}

/** Height of a vertical-span element per the CLI's hydrate rules, or undefined. */
export function spanHeight(el: CanonicalElement, baseLevel: Level, levels: Level[]): number | undefined {
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  const baseId = el.attrs.base_level_id || baseLevel.id;
  const base = sorted.find(l => l.id === baseId) ?? baseLevel;
  const topId = el.attrs.top_level_id;
  const top = topId ? sorted.find(l => l.id === topId) : sorted[sorted.findIndex(l => l.id === base.id) + 1];
  if (!top) return undefined;
  const num = (v: string | undefined) => (Number.isFinite(parseFloat(v ?? '')) ? parseFloat(v!) : 0);
  return top.elevation + num(el.attrs.top_offset) - (base.elevation + num(el.attrs.base_offset));
}

function openingArea(wall: CanonicalElement, hosted: CanonicalElement[]): number {
  let a = 0;
  for (const h of hosted) {
    if (h.hostId !== wall.id || !['door', 'window', 'opening'].includes(h.tableName)) continue;
    const w = parseFloat(h.attrs.width ?? ''), ht = parseFloat(h.attrs.height ?? '');
    if (Number.isFinite(w) && Number.isFinite(ht)) a += w * ht;
  }
  return a;
}

/**
 * Quantities of one element. `context` is the element's level (+ global
 * elements) — rooms need its walls, walls their openings.
 */
export function elementQuantities(
  el: CanonicalElement, level: Level, levels: Level[], context: CanonicalElement[],
): ElementQuantities {
  const q: ElementQuantities = {};
  const thickness = parseFloat(el.attrs.thickness ?? '');
  if (el.tableName === 'space') {
    const poly = roomPolygon(el, boundaryWalls(context));
    if (poly) {
      q.area = polygonArea(poly);
      q.perimeter = polygonPerimeter(poly);
    }
    return q;
  }
  if (el.geometry === 'line' || el.geometry === 'spatial_line') {
    if (!el.hostId) q.length = lineLength(el);
  }
  if (VERTICAL.has(el.tableName)) q.height = spanHeight(el, level, levels);
  if (['wall', 'structure_wall', 'curtain_wall'].includes(el.tableName) && q.length !== undefined && q.height !== undefined) {
    q.gross_area = q.length * q.height;
    q.area = Math.max(0, q.gross_area - openingArea(el, context));
    if (Number.isFinite(thickness)) q.volume = q.area * thickness;
  }
  if (SLABS.has(el.tableName) && el.geometry === 'polygon' && el.vertices.length >= 3) {
    q.area = polygonArea(el.vertices);
    q.perimeter = polygonPerimeter(el.vertices);
    if (Number.isFinite(thickness)) q.volume = q.area * thickness;
  }
  if (STRUCTURAL.has(el.tableName)) {
    const s = structuralQuantities(el, level.elevation, new Map(levels.map(l => [l.id, l.elevation])));
    if (s.volume !== undefined && (q.height !== undefined || !VERTICAL.has(el.tableName))) q.volume = s.volume;
    // Polygon slabs / rafts: area net of their holes.
    if (s.area !== undefined && el.geometry === 'polygon') q.area = s.area;
  }
  return q;
}

/** Centre of an element in plan, for zooming the plan to a schedule row. */
export function elementBounds(el: CanonicalElement): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Point[] = el.geometry === 'point' ? [el.position]
    : el.geometry === 'polygon' ? el.vertices
    : [el.start, el.end];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
