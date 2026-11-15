/**
 * Editor document → clash model (clash.ts). The editor sees one level: its
 * MEP, structure and walls, plus the slabs, roofs and framing of the level
 * above (the ceiling side of this level). Coordinates stay in the current
 * level's frame (z relative to its elevation).
 */
import type { CanonicalElement, LineElement, Point, PointElement, PolygonElement, SpatialLineElement } from '../model/elements.ts';
import { isMepLineTable } from '../model/mepTopology.ts';
import { endZ } from '../model/mepSplit.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { crossLevelIndex, shaftRange } from '../model/crossLevel.ts';
import { tessellateArc } from '../geometry/arc.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import type { ProjectData } from '../types.ts';
import type { ClashModelIn, ClashSlabIn, Vec2, Vec3, WallOpeningIn } from './clash.ts';

const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
const DEFAULT_SHAPE: Record<string, 'rect' | 'round'> = { duct: 'rect', pipe: 'round', conduit: 'round', cable_tray: 'rect' };
const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);
const COLUMN_TABLES = new Set(['column', 'structure_column']);
const SLAB_TABLES = new Set(['slab', 'structure_slab', 'roof']);
const HOSTED_TABLES = new Set(['door', 'window', 'opening']);
/** Tables taken from the level above. */
const ABOVE_TABLES = new Set(['slab', 'structure_slab', 'roof', 'beam', 'brace', 'opening']);

type Line = LineElement | SpatialLineElement;
const isLine = (el: CanonicalElement): el is Line => el.geometry === 'line' || el.geometry === 'spatial_line';
const sectionShape = (s: string | undefined): 'rect' | 'round' => ((s ?? '').trim() === 'round' ? 'round' : 'rect');
const xy = (p: Point): Vec2 => [p.x, p.y];

function lineZ(el: Line, side: 'start' | 'end'): number {
  if (el.geometry === 'spatial_line') return side === 'start' ? el.startZ : el.endZ;
  const base = num(el.attrs.base_offset);
  return num(el.attrs[side === 'start' ? 'start_z' : 'end_z'], base);
}

/** Level directly above `levelId` (by elevation), if any. */
export function levelAbove(project: ProjectData | null, levelId: string): { id: string; dz: number } | null {
  if (!project) return null;
  const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
  const i = sorted.findIndex(l => l.id === levelId);
  if (i < 0 || i + 1 >= sorted.length) return null;
  return { id: sorted[i + 1].id, dz: sorted[i + 1].elevation - sorted[i].elevation };
}

/**
 * The clash model of the open level. `above` (the level above's elements and
 * its height over this level) adds that level's slabs, roofs and framing,
 * tagged with its id as scope; this level's elements have no scope.
 */
export function buildClashModel(
  elements: ReadonlyMap<string, CanonicalElement>,
  opts: { project?: ProjectData | null; levelId?: string; unitsPerMetre?: number } = {},
): ClashModelIn {
  const upm = opts.unitsPerMetre ?? 1;
  const project = opts.project ?? null;
  const levelId = opts.levelId ?? '';
  const elevations = new Map((project?.levels ?? []).map(l => [l.id, l.elevation]));
  const levelElevation = elevations.get(levelId) ?? 0;
  const m: ClashModelIn = { curves: [], hosts: [], members: [], boxes: [], walls: [], slabs: [] };

  // Hosted openings by host id (walls: door / window / opening spans; slabs: polygon openings).
  const hostedOf = new Map<string, CanonicalElement[]>();
  for (const el of elements.values()) {
    if (!HOSTED_TABLES.has(el.tableName) || !el.hostId) continue;
    const list = hostedOf.get(el.hostId) ?? [];
    list.push(el);
    hostedOf.set(el.hostId, list);
  }
  // Largest run on each node, for accessories without their own size.
  const nodeSize = new Map<string, number>();
  for (const el of elements.values()) {
    if (!isMepLineTable(el.tableName)) continue;
    const s = Math.max(num(el.attrs.size_x), num(el.attrs.size_y));
    for (const ref of [el.attrs.from, el.attrs.to]) {
      const host = (ref ?? '').split(':')[0].trim();
      if (host) nodeSize.set(host, Math.max(nodeSize.get(host) ?? 0, s));
    }
  }
  const shafts = crossLevelIndex(project, { levelId, elements })?.shafts ?? [];

  const addFraming = (el: Line, scope: string | undefined, dz: number) => {
    const w = num(el.attrs.size_x, el.tableName === 'beam' ? 0.3 * upm : 0.2 * upm);
    const round = sectionShape(el.attrs.shape) === 'round';
    if ((el.attrs.shape ?? '').trim() === 'open_web') {
      // Open-web joist: only its chords are solid (ducts and pipes run through the web)
      const d = num(el.attrs.size_y, 0.356 * upm), f = Math.min(num(el.attrs.flange, Math.min(0.032 * upm, d * 0.12)), d / 3);
      for (const drop of [0, d - f]) {
        m.members!.push({
          id: el.id, scope, table: el.tableName,
          a: [el.start.x, el.start.y, lineZ(el, 'start') + dz - drop], b: [el.end.x, el.end.y, lineZ(el, 'end') + dz - drop],
          shape: 'rect', w, h: f, top: true,
        });
      }
      return;
    }
    m.members!.push({
      id: el.id, scope, table: el.tableName,
      a: [el.start.x, el.start.y, lineZ(el, 'start') + dz], b: [el.end.x, el.end.y, lineZ(el, 'end') + dz],
      shape: round ? 'round' : 'rect', w, h: num(el.attrs.size_y, round ? w : el.tableName === 'beam' ? 0.5 * upm : 0.2 * upm), top: true,
    });
  };

  const addSlab = (el: PolygonElement, scope: string | undefined, dz: number, hosted: readonly CanonicalElement[]) => {
    if (el.vertices.length < 3) return;
    if (el.tableName === 'roof' && ((el.attrs.roof_type && el.attrs.roof_type !== 'flat') || num(el.attrs.slope) > 0)) return; // sloped roofs: not modelled
    const off = num(el.attrs.base_offset) + dz;
    const th = num(el.attrs.thickness, 0.2 * upm);
    const [z0, z1] = el.tableName === 'roof' ? [off, off + th] : [off - th, off];
    const holes: Vec2[][] = (el.holes ?? []).map(h => h.map(xy));
    for (const o of hosted) if (o.tableName === 'opening' && o.geometry === 'polygon' && !o.attrs.top_level_id) holes.push((o as PolygonElement).vertices.map(xy));
    for (const s of shafts) {
      const r = shaftRange(s, elevations);
      if (!r || s.el.geometry !== 'polygon') continue;
      if (r[0] - levelElevation < z1 - 1e-6 && r[1] - levelElevation > z0 + 1e-6) holes.push((s.el as PolygonElement).vertices.map(xy));
    }
    const slab: ClashSlabIn = { id: el.id, scope, table: el.tableName, outer: el.vertices.map(xy), holes, z0, z1, structural: el.tableName === 'foundation' };
    m.slabs!.push(slab);
  };

  for (const el of elements.values()) {
    const t = el.tableName;
    if (isMepLineTable(t) && isLine(el)) {
      const w = num(el.attrs.size_x, t === 'duct' ? 0.2 * upm : 0.05 * upm);
      m.curves.push({
        id: el.id, table: t,
        a: [el.start.x, el.start.y, endZ(el, 'start')], b: [el.end.x, el.end.y, endZ(el, 'end')],
        shape: (el.attrs.shape || '').trim() ? sectionShape(el.attrs.shape) : DEFAULT_SHAPE[t] ?? 'rect',
        w, h: num(el.attrs.size_y, w), insulation: num(el.attrs.insulation_thickness),
        system: (el.attrs.system_type ?? '').trim(), from: el.attrs.from ?? '', to: el.attrs.to ?? '',
      });
    } else if ((t === 'equipment' || t === 'terminal' || t === 'mep_node') && el.geometry === 'point') {
      const p = el as PointElement;
      const z = num(p.attrs.base_offset);
      const system = (p.attrs.system_type ?? '').trim();
      const rotation = num(p.attrs.rotation);
      if (t === 'mep_node') {
        const kind = (p.attrs.kind ?? '').trim();
        const s = Math.max(num(p.attrs.size_w), num(p.attrs.size_h), nodeSize.get(p.id) ?? 0, 0.05 * upm) / 2;
        m.hosts.push({ id: p.id, table: t, center: [p.position.x, p.position.y, z], half: [s, s, s], rotation, system, fitting: !kind });
      } else {
        const h = num(p.attrs.height, 0.5 * upm);
        m.hosts.push({ id: p.id, table: t, center: [p.position.x, p.position.y, z + h / 2], half: [p.width / 2, p.height / 2, h / 2], rotation, system });
      }
    } else if ((t === 'beam' || t === 'brace') && isLine(el)) {
      addFraming(el, undefined, 0);
    } else if (COLUMN_TABLES.has(t) && el.geometry === 'point') {
      const p = el as PointElement;
      const { height, baseOffset } = resolveHeight(p.attrs, levelElevation, elevations, 3 * upm);
      m.members!.push({
        id: p.id, table: t, a: [p.position.x, p.position.y, baseOffset], b: [p.position.x, p.position.y, baseOffset + height],
        shape: sectionShape(p.attrs.shape), w: p.width, h: p.height, rotation: num(p.attrs.rotation),
      });
    } else if (WALL_TABLES.has(t) && el.geometry === 'line') {
      const w = el as LineElement;
      const { height, baseOffset } = resolveHeight(w.attrs, levelElevation, elevations, 3 * upm);
      const z0 = baseOffset, z1 = baseOffset + height;
      const thickness = t === 'curtain_wall' ? num(w.attrs.mullion_depth, 0.1 * upm) : w.strokeWidth || num(w.attrs.thickness, 0.2 * upm);
      const structural = t === 'structure_wall';
      if (w.arc) {
        const pts = tessellateArc(w.start, w.end, w.arc, 0.5 * upm);
        for (let i = 0; i + 1 < pts.length; i++) m.walls!.push({ id: w.id, table: t, a: xy(pts[i]), b: xy(pts[i + 1]), thickness, z0, z1, structural });
        continue;
      }
      const L = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      const openings: WallOpeningIn[] = [];
      for (const o of hostedOf.get(w.id) ?? []) {
        if (!isLine(o) || L < 1e-9) continue;
        const ux = (w.end.x - w.start.x) / L, uy = (w.end.y - w.start.y) / L;
        const u0 = (o.start.x - w.start.x) * ux + (o.start.y - w.start.y) * uy;
        const u1 = (o.end.x - w.start.x) * ux + (o.end.y - w.start.y) * uy;
        const isWindow = o.tableName === 'window';
        const rawSill = o.attrs.base_offset;
        const sill = rawSill !== undefined && rawSill !== '' ? num(rawSill) : isWindow ? 0.9 * upm : 0;
        const h = num(o.attrs.height, (isWindow ? 1.2 : 2.1) * upm);
        openings.push({ u0: Math.min(u0, u1), u1: Math.max(u0, u1), z0: z0 + sill, z1: z0 + sill + h });
      }
      m.walls!.push({ id: w.id, table: t, a: xy(w.start), b: xy(w.end), thickness, z0, z1, structural, openings });
    } else if (SLAB_TABLES.has(t) && el.geometry === 'polygon') {
      addSlab(el as PolygonElement, undefined, 0, hostedOf.get(el.id) ?? []);
    } else if (t === 'foundation') {
      const top = num(el.attrs.base_offset);
      const th = num(el.attrs.thickness, 0.4 * upm);
      if (el.geometry === 'point') {
        const p = el as PointElement;
        if (el.attrs.kind === 'pile' && !num(el.attrs.length)) {
          m.members!.push({ id: p.id, table: t, a: [p.position.x, p.position.y, top - th], b: [p.position.x, p.position.y, top], shape: 'round', w: p.width, h: p.width });
        } else {
          m.boxes!.push({ id: p.id, table: t, center: [p.position.x, p.position.y, top - th / 2], half: [p.width / 2, p.height / 2, th / 2], rotation: num(p.attrs.rotation) });
        }
      } else if (isLine(el)) {
        m.members!.push({ id: el.id, table: t, a: [el.start.x, el.start.y, top], b: [el.end.x, el.end.y, top], shape: 'rect', w: num(el.attrs.width, el.strokeWidth), h: th, top: true });
      } else if (el.geometry === 'polygon') {
        const pg = el as PolygonElement;
        if (pg.vertices.length >= 3) {
          m.slabs!.push({ id: pg.id, table: t, outer: pg.vertices.map(xy), holes: (pg.holes ?? []).map(h => h.map(xy)), z0: top - th, z1: top, structural: true });
        }
      }
    }
  }

  // Walls and columns of lower levels that rise into this one (a double-height
  // wall, a column through two storeys), tagged with their level as scope.
  for (const lower of project?.levels ?? []) {
    if (lower.id === levelId || lower.elevation >= levelElevation - 1e-6) continue;
    const floor = project?.floors.get(lower.id);
    if (!floor) continue;
    let els: CanonicalElement[] = [];
    try { els = parseFloorLayers(floor.layers.filter(l => WALL_TABLES.has(l.tableName) || COLUMN_TABLES.has(l.tableName))); } catch { /* unreadable layer */ }
    const dz = lower.elevation - levelElevation;
    for (const el of els) {
      const { height, baseOffset } = resolveHeight(el.attrs, lower.elevation, elevations, 3 * upm);
      const z0 = baseOffset + dz, z1 = baseOffset + height + dz;
      if (z1 <= 1e-6) continue; // stops at or below this level's floor
      if (WALL_TABLES.has(el.tableName) && el.geometry === 'line' && !(el as LineElement).arc) {
        const w = el as LineElement;
        const thickness = el.tableName === 'curtain_wall' ? num(w.attrs.mullion_depth, 0.1 * upm) : w.strokeWidth || num(w.attrs.thickness, 0.2 * upm);
        m.walls!.push({ id: w.id, scope: lower.id, table: el.tableName, a: xy(w.start), b: xy(w.end), thickness, z0, z1, structural: el.tableName === 'structure_wall' });
      } else if (COLUMN_TABLES.has(el.tableName) && el.geometry === 'point') {
        const p = el as PointElement;
        m.members!.push({ id: p.id, scope: lower.id, table: el.tableName, a: [p.position.x, p.position.y, z0], b: [p.position.x, p.position.y, z1],
          shape: sectionShape(p.attrs.shape), w: p.width, h: p.height, rotation: num(p.attrs.rotation) });
      }
    }
  }

  // The level above: its floor slab / roof and the framing under it.
  const above = levelAbove(project, levelId);
  const floor = above && project?.floors.get(above.id);
  if (above && floor) {
    let els: CanonicalElement[] = [];
    try { els = parseFloorLayers(floor.layers.filter(l => ABOVE_TABLES.has(l.tableName))); } catch { /* unreadable layer */ }
    const hosted = new Map<string, CanonicalElement[]>();
    for (const el of els) {
      if (el.tableName !== 'opening' || !el.hostId) continue;
      const list = hosted.get(el.hostId) ?? [];
      list.push(el);
      hosted.set(el.hostId, list);
    }
    for (const el of els) {
      if ((el.tableName === 'beam' || el.tableName === 'brace') && isLine(el)) addFraming(el, above.id, above.dz);
      else if (SLAB_TABLES.has(el.tableName) && el.geometry === 'polygon') addSlab(el as PolygonElement, above.id, above.dz, hosted.get(el.id) ?? []);
    }
  }
  return m;
}

/** Model-space box around a clash point (for zooming). */
export function clashBox(at: Vec3, pad: number): { min: Vec3; max: Vec3 } {
  return { min: [at[0] - pad, at[1] - pad, at[2] - pad], max: [at[0] + pad, at[1] + pad, at[2] + pad] };
}
