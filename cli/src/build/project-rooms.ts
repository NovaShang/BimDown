/**
 * The build's endpoint snap and room derivation over a project's files,
 * without file access: `bimdown build` runs them on a folder, the IFC
 * importer (also in the browser) on the files it is about to write, so the
 * import report and `bimdown build` find the same room problems.
 */
import { parseCsvText } from '../utils/csv-core.js';
import {
  parseGeoJsonText,
  stringifyFeatureCollection,
  extractLineGeometry,
  type BimDownFeatureCollection,
  type Position,
} from '../utils/geojson-core.js';
import { UNIT_TO_M, unitsOfMetadata } from '../utils/units-core.js';
import { TOLERANCE, deriveRooms, type DerivedRooms, type Segment } from './room-faces.js';

/** A project's text files by project-relative path ('lv-1/wall.geojson'). */
export interface ProjectFiles {
  read(path: string): string | undefined;
  write(path: string, text: string): void;
}

/** Project files held in memory (the importer's output). */
export function memoryFiles(files: Record<string, string>): ProjectFiles {
  return {
    read: (p) => files[p],
    write: (p, t) => { files[p] = t; },
  };
}

/** Boundary element tables (their GeoJSON files have the table's name). */
export const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

export function projectUnitsOf(files: ProjectFiles): string {
  return unitsOfMetadata(files.read('project_metadata.json'));
}

function readFc(files: ProjectFiles, path: string): BimDownFeatureCollection | null {
  const text = files.read(path);
  if (text === undefined) return null;
  try { return parseGeoJsonText(text, path); } catch { return null; }
}

// ─── Endpoint snap ───────────────────────────────────────────────────────────

/**
 * Endpoints closer than this are treated as the same junction and merged. Kept small on purpose:
 * snapping only heals imprecise coordinates; it must not move real geometry. (It used to be the
 * thickest wall in the project, which merged distinct corners up to ~0.5 m apart and skewed walls.)
 */
export const SNAP_TOLERANCE_M = 0.05; // meters; converted to the project's units
/** Never snap if it would turn a wall by more than this (degrees) — protects short walls. */
const MAX_TURN_DEG = 2;

interface Point { x: number; y: number }

interface EndpointRef {
  point: Point;
  other: Point; // the opposite endpoint of the same element
  table: string;
  elementId: string;
  side: 'start' | 'end';
}

export interface SnapRecord {
  level: string;
  table: string;
  elementId: string;
  side: 'start' | 'end';
  from: Point;
  to: Point;
}

/**
 * Merge boundary endpoints of the same folder (`global` or a level) that lie within 5 cm (in
 * project units) of each other; rewrites the GeoJSON files that changed. Returns what was moved.
 */
export function snapProjectEndpoints(files: ProjectFiles, dirs: string[]): SnapRecord[] {
  const tolerance = SNAP_TOLERANCE_M / UNIT_TO_M[projectUnitsOf(files)];
  const records: SnapRecord[] = [];
  for (const dir of dirs) {
    const fcs = new Map<string, BimDownFeatureCollection>();
    const endpoints: EndpointRef[] = [];
    for (const table of BOUNDARY_TABLES) {
      const fc = readFc(files, `${dir}/${table}.geojson`);
      if (!fc) continue;
      fcs.set(table, fc);
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const a = f.geometry.coordinates[0];
        const b = f.geometry.coordinates[f.geometry.coordinates.length - 1];
        const pa = { x: a[0], y: a[1] }, pb = { x: b[0], y: b[1] };
        endpoints.push({ point: pa, other: pb, table, elementId: id, side: 'start' });
        endpoints.push({ point: pb, other: pa, table, elementId: id, side: 'end' });
      }
    }

    // Snapping is per folder: endpoints of different levels never interact.
    const snapMap = new Map<string, Point>();
    for (const cluster of clusterEndpoints(endpoints, tolerance)) {
      if (cluster.length <= 1) continue;
      const canonical = pickCanonical(cluster);
      const moving = cluster.filter(ep => !same(ep.point, canonical));
      // A junction that already meets exactly moves whole or not at all: moving some of its
      // ends (a short wall refusing to turn) would open a gap that is not there now.
      const refused = new Set(moving.filter(ep => turnDegrees(ep.other, ep.point, canonical) > MAX_TURN_DEG).map(ep => key(ep.point)));
      for (const ep of moving) {
        if (refused.has(key(ep.point))) continue;
        snapMap.set(`${ep.table}:${ep.elementId}:${ep.side}`, canonical);
        records.push({ level: dir, table: ep.table, elementId: ep.elementId, side: ep.side, from: ep.point, to: canonical });
      }
    }
    if (snapMap.size === 0) continue;

    for (const [table, fc] of fcs) {
      let dirty = false;
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
        const id = String(f.properties?.id ?? '');
        const ns = snapMap.get(`${table}:${id}:start`);
        const ne = snapMap.get(`${table}:${id}:end`);
        if (!ns && !ne) continue;
        const coords = f.geometry.coordinates;
        if (ns) coords[0] = moved(coords[0], ns);
        if (ne) coords[coords.length - 1] = moved(coords[coords.length - 1], ne);
        dirty = true;
      }
      if (dirty) files.write(`${dir}/${table}.geojson`, stringifyFeatureCollection(fc));
    }
  }
  return records;
}

function moved(c: Position, to: Point): Position {
  return (c.length === 3 ? [to.x, to.y, c[2]] : [to.x, to.y]) as Position;
}

/** Seed clustering without chaining: every member is within `tolerance` of the seed. */
function clusterEndpoints(endpoints: EndpointRef[], tolerance: number): EndpointRef[][] {
  const visited = new Set<number>();
  const clusters: EndpointRef[][] = [];
  for (let i = 0; i < endpoints.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);
    const cluster: EndpointRef[] = [endpoints[i]];
    for (let j = i + 1; j < endpoints.length; j++) {
      if (!visited.has(j) && dist(endpoints[i].point, endpoints[j].point) < tolerance) {
        cluster.push(endpoints[j]);
        visited.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Angle (degrees) between the element direction before and after moving `from` to `to`. */
function turnDegrees(fixed: Point, from: Point, to: Point): number {
  const a = Math.atan2(from.y - fixed.y, from.x - fixed.x);
  const b = Math.atan2(to.y - fixed.y, to.x - fixed.x);
  let d = Math.abs(a - b) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6;

function pickCanonical(cluster: EndpointRef[]): Point {
  const counts = new Map<string, { point: Point; count: number }>();
  for (const ep of cluster) {
    const k = key(ep.point);
    const entry = counts.get(k);
    if (entry) entry.count++;
    else counts.set(k, { point: ep.point, count: 1 });
  }
  let best: { point: Point; count: number } = { point: cluster[0].point, count: 0 };
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  return best.point;
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

/**
 * Ids of global boundary elements standing on `level`: base at or below
 * the level, top above it (a multi-storey wall ending at a level's floor
 * doesn't divide that level's rooms). Null when the levels are unknown (all
 * global elements count, as before).
 */
function globalIdsOnLevel(files: ProjectFiles, level: string): Set<string> | null {
  const levelCsv = files.read('global/level.csv');
  if (levelCsv === undefined) return null;
  const levels = parseCsvText(levelCsv).rows
    .map((r) => ({ id: r.id, elevation: parseFloat(r.elevation ?? '') }))
    .filter((l) => !isNaN(l.elevation))
    .sort((a, b) => a.elevation - b.elevation);
  const here = levels.find((l) => l.id === level)?.elevation;
  if (here === undefined) return null;
  const elev = new Map(levels.map((l) => [l.id, l.elevation]));
  const ids = new Set<string>();
  for (const table of BOUNDARY_TABLES) {
    const csv = files.read(`global/${table}.csv`);
    const fc = readFc(files, `global/${table}.geojson`);
    if (csv === undefined || !fc) continue;
    const props = new Map<string, Record<string, unknown>>();
    for (const f of fc.features) props.set(String(f.properties?.id ?? ''), (f.properties ?? {}) as Record<string, unknown>);
    for (const row of parseCsvText(csv).rows) {
      const base = elev.get(row.base_level_id ?? '');
      if (base === undefined) { ids.add(row.id); continue; }
      const p = props.get(row.id) ?? {};
      const above = levels.find((l) => l.elevation > base + 1e-6);
      const topLevel = elev.get(row.top_level_id ?? '') ?? above?.elevation;
      const bottom = base + (Number(p.base_offset) || 0);
      const top = topLevel === undefined ? Infinity : topLevel + (Number(p.top_offset) || 0);
      if (bottom <= here + TOLERANCE && top > here + TOLERANCE) ids.add(row.id);
    }
  }
  return ids;
}

function boundarySegments(files: ProjectFiles, dir: string, only?: Set<string> | null): Segment[] {
  const segments: Segment[] = [];
  for (const table of BOUNDARY_TABLES) {
    const fc = readFc(files, `${dir}/${table}.geojson`);
    if (!fc) continue;
    try {
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        if (!id || (only && !only.has(id))) continue;
        const lg = extractLineGeometry(f);
        if (lg.length < TOLERANCE) continue;
        segments.push({ startX: lg.start_x, startY: lg.start_y, endX: lg.end_x, endY: lg.end_y, id });
      }
    } catch { /* skip */ }
  }
  return segments;
}

export interface LevelRooms {
  warnings: string[];
  /** Null when the level has no spaces or no boundary elements. */
  rooms: DerivedRooms | null;
}

/** Rooms of one level from its space seeds and the boundary lines (level + global ones standing on it). */
export function deriveLevelRooms(files: ProjectFiles, level: string): LevelRooms {
  const spaceCsv = files.read(`${level}/space.csv`);
  if (spaceCsv === undefined) return { warnings: [], rooms: null };
  const rows = parseCsvText(spaceCsv).rows;
  if (rows.length === 0) return { warnings: [], rooms: null };

  const segments = boundarySegments(files, level);
  segments.push(...boundarySegments(files, 'global', globalIdsOnLevel(files, level)));
  if (segments.length === 0) {
    return { warnings: [`${level}/  no boundary elements found for space boundary computation`], rooms: null };
  }
  const seeds = rows.map((row) => ({
    id: row.id, x: parseFloat(row.x ?? ''), y: parseFloat(row.y ?? ''), raw: [row.x, row.y] as [string, string],
  }));
  const rooms = deriveRooms(level, segments, seeds, projectUnitsOf(files));
  return { warnings: rooms.warnings, rooms };
}
