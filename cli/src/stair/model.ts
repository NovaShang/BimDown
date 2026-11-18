/**
 * Stairs of a project as runs / landings / railings (spec stair.yaml,
 * railing.yaml), read from the CSV + GeoJSON of each directory. Spatial Z in
 * GeoJSON is absolute; the model works level-relative like the editor.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverLayout } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import { parseGeoJsonFile, type BimDownFeature } from '../utils/geojson.js';
import { loadCatalog, typeValues } from '../catalog/index.js';
import {
  arcFromEnds, stairRepetitions, stairRailPath, lineRailPath, repZ,
  type Point, type RailSegment, type RailSide, type StairAssembly, type StairLanding, type StairRepetition, type StairRun,
} from './geometry.js';

export interface DirStairs {
  dir: string;
  /** Level elevation of the directory (0 for global/). */
  elevation: number;
  stairs: StairModel[];
  /** Runs / landings whose host_id is not a stair of this or the global directory. */
  orphans: { table: string; id: string; hostId: string; line: number }[];
  railings: RailingModel[];
}

export interface StairModel {
  id: string;
  line: number;
  row: Record<string, string>;
  asm: StairAssembly;
  reps: StairRepetition[];
}

export interface RailingModel {
  id: string;
  line: number;
  row: Record<string, string>;
  host: 'stair' | 'slab' | 'missing' | null;
  side?: RailSide;
  /** Path per storey repetition (level-relative Z). */
  paths: RailSegment[][];
  height: number;
}

const num = (s: string | undefined, fallback: number) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

function rows(dir: string, table: string): Map<string, { row: Record<string, string>; line: number }> {
  const out = new Map<string, { row: Record<string, string>; line: number }>();
  const p = join(dir, `${table}.csv`);
  if (!existsSync(p)) return out;
  try {
    readCsv(p).rows.forEach((row, i) => { if (row.id) out.set(row.id, { row, line: i + 2 }); });
  } catch { /* reported by validate */ }
  return out;
}

function features(dir: string, table: string): Map<string, BimDownFeature> {
  const out = new Map<string, BimDownFeature>();
  const p = join(dir, `${table}.geojson`);
  if (!existsSync(p)) return out;
  try {
    for (const f of parseGeoJsonFile(p).features) if (f.properties?.id) out.set(String(f.properties.id), f);
  } catch { /* reported by validate */ }
  return out;
}

function runFrom(id: string, table: string, row: Record<string, string>, f: BimDownFeature | undefined, elevation: number): StairRun | null {
  if (!f || f.geometry.type !== 'LineString') return null;
  const c = f.geometry.coordinates;
  if (c.length < 2) return null;
  const a = c[0], b = c[c.length - 1];
  const start = { x: a[0], y: a[1] }, end = { x: b[0], y: b[1] };
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (chord < 1e-3) return null;
  // Curved run: GeoJSON arc hint {radius, large_arc, sweep}
  const h = f.properties.arc as { radius?: number; large_arc?: boolean; sweep?: boolean } | undefined;
  const arc = h && typeof h.radius === 'number' ? arcFromEnds(start, end, h.radius, h.large_arc === true, h.sweep === true) ?? undefined : undefined;
  return {
    id, table, start, end,
    startZ: (a[2] ?? 0) - elevation, endZ: (b[2] ?? 0) - elevation,
    width: num(row.width, 1.2) || 1.2,
    stepCount: Math.max(1, Math.round(num(row.step_count, 18)) || 18),
    length: arc ? Math.abs(arc.sweep) * arc.r : chord, u: { x: (end.x - start.x) / chord, y: (end.y - start.y) / chord },
    ...(arc ? { arc } : {}),
  };
}

function landingFrom(id: string, row: Record<string, string>, f: BimDownFeature | undefined): StairLanding | null {
  if (!f || f.geometry.type !== 'Polygon') return null;
  const ring = f.geometry.coordinates[0] ?? [];
  const vertices: Point[] = ring.map(p => ({ x: p[0], y: p[1] }));
  if (vertices.length > 1) {
    const a = vertices[0], b = vertices[vertices.length - 1];
    if (a.x === b.x && a.y === b.y) vertices.pop();
  }
  if (vertices.length < 3) return null;
  const top = num(row.base_offset, typeof f.properties.base_offset === 'number' ? f.properties.base_offset : 0);
  const steps = Math.round(num(row.step_count, 0));
  return { id, vertices, top, thickness: num(row.thickness, 0.15) || 0.15, ...(steps > 0 ? { steps } : {}) };
}

function levelElevations(globalDir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, { row }] of rows(globalDir, 'level')) out.set(id, num(row.elevation, 0));
  return out;
}

/** Stairs, their parts and railings of every directory (global first). */
export function loadStairs(projectDir: string): DirStairs[] {
  const layout = discoverLayout(projectDir);
  const elevations = levelElevations(layout.globalDir);
  const catalog = loadCatalog(projectDir);
  const dirs = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs];
  const globalStairs = new Map<string, StairModel>();
  const out: DirStairs[] = [];
  for (const d of dirs) {
    if (!existsSync(d.path)) continue;
    const elevation = d.name === 'global' ? 0 : elevations.get(d.name) ?? 0;
    const stairRows = rows(d.path, 'stair'), stairFeats = features(d.path, 'stair');
    const runRows = rows(d.path, 'stair_run'), runFeats = features(d.path, 'stair_run');
    const landRows = rows(d.path, 'stair_landing'), landFeats = features(d.path, 'stair_landing');
    const stairs = new Map<string, StairModel>();
    const extra = new Map<string, StairRun[]>();
    const lands = new Map<string, StairLanding[]>();
    const orphans: DirStairs['orphans'] = [];
    const known = (h: string) => stairRows.has(h) || globalStairs.has(h);
    for (const [id, { row, line }] of runRows) {
      if (!known(row.host_id ?? '')) { orphans.push({ table: 'stair_run', id, hostId: row.host_id ?? '', line }); continue; }
      const r = runFrom(id, 'stair_run', row, runFeats.get(id), elevation);
      if (r) (extra.get(row.host_id) ?? extra.set(row.host_id, []).get(row.host_id)!).push(r);
    }
    for (const [id, { row, line }] of landRows) {
      if (!known(row.host_id ?? '')) { orphans.push({ table: 'stair_landing', id, hostId: row.host_id ?? '', line }); continue; }
      const l = landingFrom(id, row, landFeats.get(id));
      if (l) (lands.get(row.host_id) ?? lands.set(row.host_id, []).get(row.host_id)!).push(l);
    }
    for (const [id, { row, line }] of stairRows) {
      const own = runFrom(id, 'stair', row, stairFeats.get(id), elevation);
      const more = (extra.get(id) ?? []).sort((a, b) => Math.min(a.startZ, a.endZ) - Math.min(b.startZ, b.endZ));
      const ownIsRun = !!own && !(more.length > 0
        && Math.abs(Math.min(own.startZ, own.endZ) - Math.min(...more.map(r => Math.min(r.startZ, r.endZ)))) < 1e-3
        && Math.abs(Math.max(own.startZ, own.endZ) - Math.max(...more.map(r => Math.max(r.startZ, r.endZ)))) < 1e-3);
      const asm: StairAssembly = { stairId: id, runs: [...(own && ownIsRun ? [own] : []), ...more], landings: lands.get(id) ?? [], ownIsRun };
      const reps = d.name === 'global' ? [{ index: 0, levelId: '', dz: 0, scale: 1 }] : stairRepetitions(row, d.name, elevation, elevations);
      const m = { id, line, row, asm, reps };
      stairs.set(id, m);
      if (d.name === 'global') globalStairs.set(id, m);
    }
    // Railings
    const railRows = rows(d.path, 'railing'), railFeats = features(d.path, 'railing');
    const slabTops = new Map<string, number>();
    for (const t of ['slab', 'structure_slab']) {
      const feats = features(d.path, t);
      for (const [id, { row }] of rows(d.path, t)) {
        const f = feats.get(id);
        slabTops.set(id, num(row.base_offset, typeof f?.properties.base_offset === 'number' ? f.properties.base_offset : 0));
      }
    }
    const railings: RailingModel[] = [];
    for (const [id, { row, line }] of railRows) {
      const t = row.type_id ? catalog.types.get(row.type_id) : undefined;
      const tv = t && t.table === 'railing_type' ? typeValues(t) : {};
      const height = num(row.height, num(tv.height, 1.0));
      const hostId = row.host_id ?? '';
      const stair = stairs.get(hostId) ?? globalStairs.get(hostId);
      const f = railFeats.get(id);
      if (stair) {
        const side: RailSide = row.side === 'right' ? 'right' : 'left';
        const base = stairRailPath(stair.asm, side);
        const paths = stair.reps.map(rep => base.map(s => ({
          a: { ...s.a, z: repZ(rep, s.a.z) }, b: { ...s.b, z: repZ(rep, s.b.z) },
          run: s.run && { ...s.run, startZ: repZ(rep, s.run.startZ), riser: s.run.riser * rep.scale },
        })));
        railings.push({ id, line, row, host: 'stair', side, paths, height });
        continue;
      }
      const host: RailingModel['host'] = hostId ? (slabTops.has(hostId) ? 'slab' : 'missing') : null;
      let paths: RailSegment[][] = [];
      if (f && f.geometry.type === 'LineString' && f.geometry.coordinates.length >= 2) {
        const c = f.geometry.coordinates;
        const segs: RailSegment[] = [];
        for (let i = 0; i + 1 < c.length; i++) {
          const z0 = host === 'slab' ? slabTops.get(hostId)! : (c[i][2] ?? elevation) - elevation;
          const z1 = host === 'slab' ? slabTops.get(hostId)! : (c[i + 1][2] ?? elevation) - elevation;
          segs.push(...lineRailPath({ x: c[i][0], y: c[i][1] }, { x: c[i + 1][0], y: c[i + 1][1] }, z0, z1));
        }
        paths = [segs];
      }
      railings.push({ id, line, row, host, paths, height });
    }
    out.push({ dir: d.name, elevation, stairs: [...stairs.values()], orphans, railings });
  }
  return out;
}
