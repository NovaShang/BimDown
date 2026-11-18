/**
 * Load a project for clash detection (clash.ts): MEP curves and devices plus
 * the building obstacles, in absolute world coordinates (project units).
 * Level-anchored elements take Z from their level + base_offset / top level +
 * top_offset; spatial ones (curves, beams, braces) from their 3D coords.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from '../utils/csv.js';
import { extractLineGeometry, extractPointGeometry, extractPolygonGeometry, type BimDownFeature } from '../utils/geojson.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { effectiveRows } from '../catalog/index.js';
import { metersToProject, projectUnits, UNIT_TO_M } from '../utils/units.js';
import { MEP_CURVE_TABLES, num, levelElevations, featuresById } from './load.js';
import { roofInputFor, solveRoof, verticalThickness } from '../geo/roof-solver.js';
import {
  detectClashes, clashCounts,
  type Clash, type ClashModelIn, type ClashSeverity, type ClashSlabIn, type ClashWallIn, type Vec2, type Vec3, type WallOpeningIn,
} from './clash.js';

const DEFAULT_SHAPE: Record<string, 'rect' | 'round'> = { duct: 'rect', pipe: 'round', conduit: 'round', cable_tray: 'rect' };
const MEMBER_DEFAULTS: Record<string, [number, number]> = { beam: [0.3, 0.5], brace: [0.2, 0.2] };
const WALL_TABLES = ['wall', 'structure_wall', 'curtain_wall'];
const COLUMN_TABLES = ['column', 'structure_column'];
const SLAB_TABLES = ['slab', 'structure_slab', 'roof'];

/** A roof as clash slabs: flat as it is, sloped one band per roof plane piece (as the editor's clashModel.roofFaces). */
function roofFaces(base: ClashSlabIn, outline: { x: number; y: number }[], attrs: Record<string, string>, thickness: number): ClashSlabIn[] {
  const sol = solveRoof(roofInputFor(outline, attrs));
  if (!(sol.maxSlopeDeg > 0) || sol.pieces.length === 0) return [base];
  const vThick = verticalThickness(thickness, sol.maxSlopeDeg);
  return sol.pieces.map(pc => {
    const pl = sol.planes[pc.plane];
    const z0 = base.z0 + pl.c;
    return { ...base, outer: pc.poly.map(p => [p.x, p.y] as Vec2), z0, z1: z0 + vThick, grad: [pl.a, pl.b] as Vec2 };
  });
}

interface Dir { name: string; path: string; base: number; files: Set<string> }

function rowsOf(projectDir: string, d: Dir, table: string): Record<string, string>[] {
  if (!d.files.has(`${table}.csv`)) return [];
  try { return effectiveRows(projectDir, table, readCsv(join(d.path, `${table}.csv`)).rows); } catch { return []; }
}

const sectionShape = (s: string | undefined): 'rect' | 'round' => ((s ?? '').trim() === 'round' ? 'round' : 'rect');

/** The clash model of a project; MEP of `level` only when given (obstacles always from every level). */
export function loadClashModel(dir: string, level?: string): ClashModelIn {
  const layout = discoverLayout(dir);
  const elev = levelElevations(dir);
  const sorted = [...elev.values()].sort((a, b) => a - b);
  const unitM = UNIT_TO_M[projectUnits(dir)];
  const defaultHeight = 3 / unitM;
  const dirs: Dir[] = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs]
    .filter(d => existsSync(d.path))
    .map(d => ({ ...d, base: elev.get(d.name) ?? 0, files: new Set(listFiles(d.path)) }));
  const m: ClashModelIn = { curves: [], hosts: [], members: [], boxes: [], walls: [], slabs: [] };
  const geoCache = new Map<string, Map<string, BimDownFeature>>();
  const geo = (d: Dir, table: string) => {
    const p = join(d.path, `${table}.geojson`);
    let g = geoCache.get(p);
    if (!g) geoCache.set(p, g = featuresById(p));
    return g;
  };

  /** Bottom and top of a level-anchored vertical element. */
  const span = (d: Dir, row: Record<string, string>, f: BimDownFeature): [number, number] => {
    const baseLevel = row.base_level_id && elev.has(row.base_level_id) ? elev.get(row.base_level_id)! : d.base;
    const bottom = baseLevel + num(f.properties?.base_offset ?? row.base_offset);
    const topLevel = elev.get(row.top_level_id ?? '') ?? sorted.find(e => e > baseLevel + 1e-6);
    let top = topLevel === undefined ? NaN : topLevel + num(f.properties?.top_offset ?? row.top_offset);
    if (!(top > bottom)) top = bottom + (num(row.height) > 0 ? num(row.height) : defaultHeight);
    return [bottom, top];
  };

  // Shafts: polygon openings with a top level cut every slab they span.
  const shafts: { ring: Vec2[]; z0: number; z1: number }[] = [];
  for (const d of dirs) {
    for (const row of rowsOf(dir, d, 'opening')) {
      if (!row.top_level_id) continue;
      const f = geo(d, 'opening').get(row.id);
      if (!f || f.geometry.type !== 'Polygon') continue;
      const top = elev.get(row.top_level_id);
      if (top === undefined) continue;
      const ring = extractPolygonGeometry(f).outer.map(p => [p.x, p.y] as Vec2);
      shafts.push({ ring, z0: d.base + num(row.base_offset), z1: top + num(row.top_offset) });
    }
  }

  for (const d of dirs) {
    const mine = !level || d.name === level;
    const scope = d.name;

    if (mine) {
      for (const t of MEP_CURVE_TABLES) {
        for (const row of rowsOf(dir, d, t)) {
          const f = geo(d, t).get(row.id);
          if (!f || f.geometry.type !== 'LineString') continue;
          let lg;
          try { lg = extractLineGeometry(f); } catch { continue; }
          const z = d.base + num(f.properties?.base_offset);
          const w = num(row.size_x, t === 'duct' ? 0.2 / unitM : 0.05 / unitM);
          m.curves.push({
            id: row.id, scope, table: t,
            a: [lg.start_x, lg.start_y, lg.start_z ?? z], b: [lg.end_x, lg.end_y, lg.end_z ?? z],
            shape: (row.shape || '').trim() ? sectionShape(row.shape) : DEFAULT_SHAPE[t],
            w, h: num(row.size_y, w), insulation: num(row.insulation_thickness),
            system: (row.system_type ?? '').trim(), from: row.from ?? '', to: row.to ?? '',
          });
        }
      }
      // Largest run on each node, for accessories without their own size.
      const nodeSize = new Map<string, number>();
      for (const c of m.curves) {
        if (c.scope !== scope) continue;
        for (const ref of [c.from, c.to]) {
          const host = (ref ?? '').split(':')[0].trim();
          if (host) nodeSize.set(host, Math.max(nodeSize.get(host) ?? 0, c.w, c.h));
        }
      }
      for (const t of ['equipment', 'terminal', 'mep_node']) {
        for (const row of rowsOf(dir, d, t)) {
          const f = geo(d, t).get(row.id);
          if (!f || f.geometry.type !== 'Point') continue;
          const pg = extractPointGeometry(f);
          const z = pg.z ?? d.base + num(f.properties?.base_offset);
          const system = (row.system_type ?? '').trim();
          if (t === 'mep_node') {
            const kind = (row.kind ?? '').trim();
            // Accessories: a small cube on the run (z = its centre line); passive fittings are joints only.
            const s = Math.max(num(row.size_w), num(row.size_h), nodeSize.get(row.id) ?? 0, 0.05 / unitM) / 2;
            m.hosts.push({ id: row.id, scope, table: t, center: [pg.x, pg.y, z], half: [s, s, s], rotation: pg.rotation, system, fitting: !kind });
            continue;
          }
          const size = Array.isArray(f.properties?.size) ? (f.properties.size as number[]) : [];
          const w = num(row.size_x, size[0] ?? 0.3 / unitM), dd = num(row.size_y, size[1] ?? w);
          const h = num(row.height, size[2] ?? 0.5 / unitM);
          m.hosts.push({ id: row.id, scope, table: t, center: [pg.x, pg.y, z + h / 2], half: [w / 2, dd / 2, h / 2], rotation: pg.rotation, system });
        }
      }
    } else {
      // Other levels' fittings and devices still resolve this level's refs.
      for (const t of ['equipment', 'terminal', 'mep_node']) {
        for (const row of rowsOf(dir, d, t)) m.hosts.push({ id: row.id, scope, table: t, center: [0, 0, 0], half: [0, 0, 0], system: '', fitting: true });
      }
    }

    // Framing.
    for (const t of ['beam', 'brace']) {
      for (const row of rowsOf(dir, d, t)) {
        const f = geo(d, t).get(row.id);
        if (!f || f.geometry.type !== 'LineString') continue;
        let lg;
        try { lg = extractLineGeometry(f); } catch { continue; }
        const z = d.base + num(f.properties?.base_offset);
        const [dw, dh] = MEMBER_DEFAULTS[t];
        const w = num(row.size_x, dw / unitM);
        if ((row.shape ?? '').trim() === 'open_web') {
          // Open-web joist: only its chords are solid (ducts and pipes run through the web)
          const d = num(row.size_y, 0.356 / unitM), fl = Math.min(num(row.flange, Math.min(0.032 / unitM, d * 0.12)), d / 3);
          for (const drop of [0, d - fl]) {
            m.members!.push({
              id: row.id, scope, table: t,
              a: [lg.start_x, lg.start_y, (lg.start_z ?? z) - drop], b: [lg.end_x, lg.end_y, (lg.end_z ?? z) - drop],
              shape: 'rect', w, h: fl, top: true,
            });
          }
          continue;
        }
        m.members!.push({
          id: row.id, scope, table: t,
          a: [lg.start_x, lg.start_y, lg.start_z ?? z], b: [lg.end_x, lg.end_y, lg.end_z ?? z],
          shape: sectionShape(row.shape), w, h: num(row.size_y, row.shape === 'round' ? w : dh / unitM), top: true,
        });
      }
    }
    for (const t of COLUMN_TABLES) {
      for (const row of rowsOf(dir, d, t)) {
        const f = geo(d, t).get(row.id);
        if (!f || f.geometry.type !== 'Point') continue;
        const pg = extractPointGeometry(f);
        const [z0, z1] = span(d, row, f);
        const w = num(row.size_x, 0.4 / unitM);
        m.members!.push({
          id: row.id, scope, table: t, a: [pg.x, pg.y, z0], b: [pg.x, pg.y, z1],
          shape: sectionShape(row.shape), w, h: num(row.size_y, w), rotation: pg.rotation,
        });
      }
    }
    // Foundations: top at level + base_offset, the body hangs down by `thickness`.
    for (const row of rowsOf(dir, d, 'foundation')) {
      const f = geo(d, 'foundation').get(row.id);
      if (!f) continue;
      const top = d.base + num(f.properties?.base_offset ?? row.base_offset);
      const th = num(row.thickness, 0.4 / unitM);
      const width = num(row.width, 1.5 / unitM);
      if (f.geometry.type === 'Point') {
        const pg = extractPointGeometry(f);
        if ((row.kind ?? '') === 'pile' && !num(row.length)) {
          m.members!.push({ id: row.id, scope, table: 'foundation', a: [pg.x, pg.y, top - th], b: [pg.x, pg.y, top], shape: 'round', w: width, h: width });
        } else {
          const length = num(row.length, width);
          m.boxes!.push({ id: row.id, scope, table: 'foundation', center: [pg.x, pg.y, top - th / 2], half: [width / 2, length / 2, th / 2], rotation: pg.rotation });
        }
      } else if (f.geometry.type === 'LineString') {
        let lg;
        try { lg = extractLineGeometry(f); } catch { continue; }
        m.members!.push({ id: row.id, scope, table: 'foundation', a: [lg.start_x, lg.start_y, top], b: [lg.end_x, lg.end_y, top], shape: 'rect', w: width, h: th, top: true });
      } else {
        const pg = extractPolygonGeometry(f);
        m.slabs!.push({
          id: row.id, scope, table: 'foundation', outer: pg.outer.map(p => [p.x, p.y]), holes: pg.holes.map(h => h.map(p => [p.x, p.y])),
          z0: top - th, z1: top, structural: true,
        });
      }
    }

    // Walls with their doors, windows and openings.
    const hosted = new Map<string, Record<string, string>[]>();
    for (const t of ['door', 'window', 'opening']) {
      for (const row of rowsOf(dir, d, t)) {
        if (!row.host_id || row.top_level_id) continue;
        const list = hosted.get(row.host_id) ?? [];
        list.push({ ...row, __table: t });
        hosted.set(row.host_id, list);
      }
    }
    for (const t of WALL_TABLES) {
      for (const row of rowsOf(dir, d, t)) {
        const f = geo(d, t).get(row.id);
        if (!f || f.geometry.type !== 'LineString') continue;
        let lg;
        try { lg = extractLineGeometry(f); } catch { continue; }
        const [z0, z1] = span(d, row, f);
        const a: Vec2 = [lg.start_x, lg.start_y], b: Vec2 = [lg.end_x, lg.end_y];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const thickness = t === 'curtain_wall' ? num(row.mullion_depth, 0.1 / unitM) : num(row.thickness, 0.2 / unitM);
        const openings: WallOpeningIn[] = [];
        for (const o of hosted.get(row.id) ?? []) {
          let pos = num(o.position, NaN);
          if (!Number.isFinite(pos) && o.host_x !== undefined && o.host_x !== '' && L > 0) {
            pos = ((num(o.host_x) - a[0]) * (b[0] - a[0]) + (num(o.host_y) - a[1]) * (b[1] - a[1])) / L;
          }
          if (!Number.isFinite(pos)) continue;
          const width = num(o.width, 0.9 / unitM);
          const isWindow = o.__table === 'window';
          const sill = o.base_offset !== undefined && o.base_offset !== '' ? num(o.base_offset) : isWindow ? 0.9 / unitM : 0;
          const height = num(o.height, (isWindow ? 1.2 : 2.1) / unitM);
          openings.push({ u0: pos - width / 2, u1: pos + width / 2, z0: z0 + sill, z1: z0 + sill + height });
        }
        const wall: ClashWallIn = { id: row.id, scope, table: t, a, b, thickness, z0, z1, structural: t === 'structure_wall', openings };
        m.walls!.push(wall);
      }
    }

    // Slabs and flat roofs, with their openings and the shafts through them.
    const slabHoles = new Map<string, Vec2[][]>();
    for (const row of rowsOf(dir, d, 'opening')) {
      if (!row.host_id || row.top_level_id) continue;
      const f = geo(d, 'opening').get(row.id);
      if (!f || f.geometry.type !== 'Polygon') continue;
      const list = slabHoles.get(row.host_id) ?? [];
      list.push(extractPolygonGeometry(f).outer.map(p => [p.x, p.y] as Vec2));
      slabHoles.set(row.host_id, list);
    }
    for (const t of SLAB_TABLES) {
      for (const row of rowsOf(dir, d, t)) {
        const f = geo(d, t).get(row.id);
        if (!f || f.geometry.type !== 'Polygon') continue;
        const pg = extractPolygonGeometry(f);
        const off = d.base + num(f.properties?.base_offset ?? row.base_offset);
        const th = num(row.thickness, 0.2 / unitM);
        const [z0, z1] = t === 'roof' ? [off, off + th] : [off - th, off];
        const holes: Vec2[][] = [...pg.holes.map(h => h.map(p => [p.x, p.y] as Vec2)), ...(slabHoles.get(row.id) ?? [])];
        for (const s of shafts) if (s.z0 < z1 - 1e-6 && s.z1 > z0 + 1e-6) holes.push(s.ring);
        const slab: ClashSlabIn = { id: row.id, scope, table: t, outer: pg.outer.map(p => [p.x, p.y]), holes, z0, z1 };
        if (t === 'roof') m.slabs!.push(...roofFaces(slab, pg.outer, row, th));
        else m.slabs!.push(slab);
      }
    }
  }
  return m;
}

export interface ClashReportOptions {
  /** Overlaps no deeper than this are within tolerance, not clashes; metres (default 0.05, 0 = every overlap). */
  toleranceM?: number;
  /** Clearance distance, mm (default 0 = off). */
  clearanceMm?: number;
  level?: string;
  mepOnly?: boolean;
  /** Also list the overlaps within tolerance (`minor`). */
  minor?: boolean;
}

export interface ClashReport {
  units: string;
  /** Tolerance used, metres. */
  tolerance: number;
  counts: Record<ClashSeverity, number>;
  clashes: Clash[];
  /** Overlaps within tolerance: their count, and the list with `minor`. */
  minorCount: number;
  minor?: Clash[];
}

export function clashReport(dir: string, opts: ClashReportOptions = {}): ClashReport {
  const model = loadClashModel(dir, opts.level);
  const tolerance = opts.toleranceM ?? 0.05;
  const all = detectClashes(model, {
    tolerance: metersToProject(dir, tolerance),
    clearance: metersToProject(dir, (opts.clearanceMm ?? 0) / 1000),
    mepOnly: opts.mepOnly,
    minor: true,
  });
  const clashes = all.filter(c => !c.minor), minor = all.filter(c => c.minor);
  return {
    units: projectUnits(dir), tolerance, counts: clashCounts(clashes), clashes,
    minorCount: minor.length, ...(opts.minor ? { minor } : {}),
  };
}

const SEVERITIES: ClashSeverity[] = ['high', 'medium', 'low'];

/** Human-readable report grouped by severity. */
export function formatClashReport(r: ClashReport): string[] {
  const unitM = UNIT_TO_M[r.units] ?? 1;
  const mm = (v: number) => `${Math.round(v * unitM * 1000)} mm`;
  const fmt = (p: Vec3) => `(${p.map(v => v.toFixed(2)).join(', ')})`;
  const row = (c: Clash) => {
    const a = `${c.aScope ? `${c.aScope}/` : ''}${c.aTable} ${c.a}`;
    const b = `${c.bScope && c.bScope !== c.aScope ? `${c.bScope}/` : ''}${c.bTable} ${c.b}`;
    const what = c.kind === 'clearance' ? `gap ${mm(c.depth)}` : `${c.kind} ${mm(c.depth)}`;
    return `  ${a}  x  ${b}  ${what}  at ${fmt(c.at)}${c.systems.length ? `  [${c.systems.join(', ')}]` : ''}`;
  };
  const out: string[] = [];
  for (const sev of SEVERITIES) {
    const list = r.clashes.filter(c => c.severity === sev);
    if (list.length === 0) continue;
    out.push(`${sev.toUpperCase()} (${list.length})`);
    for (const c of list) out.push(row(c));
    out.push('');
  }
  const tol = `${Math.round(r.tolerance * 1000)} mm`;
  if (r.minor && r.minor.length > 0) {
    out.push(`MINOR, WITHIN TOLERANCE ${tol} (${r.minor.length})`);
    for (const c of r.minor) out.push(row(c));
    out.push('');
  }
  const total = r.clashes.length;
  out.push(total === 0 ? 'No clashes.' : `${total} clash(es): ${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.low} low.`);
  if (r.minorCount > 0) out.push(`${r.minorCount} minor overlap(s) within the ${tol} tolerance not reported${r.minor ? '' : ' (--minor lists them)'}.`);
  return out;
}
