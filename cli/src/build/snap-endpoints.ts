import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  type BimDownFeatureCollection,
  type Position,
} from '../utils/geojson.js';
import { writeFileSync } from 'node:fs';
import { discoverLayout } from '../utils/fs.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { metersToProject } from '../utils/units.js';

/**
 * Endpoints closer than this are treated as the same junction and merged. Kept small on purpose:
 * snapping only heals imprecise coordinates; it must not move real geometry. (It used to be the
 * thickest wall in the project, which merged distinct corners up to ~0.5 m apart and skewed walls.)
 */
const SNAP_TOLERANCE_M = 0.05; // meters; converted to the project's units
/** Never snap if it would turn a wall by more than this (degrees) — protects short walls. */
const MAX_TURN_DEG = 2;

const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

interface Point { x: number; y: number }

interface EndpointRef {
  point: Point;
  other: Point; // the opposite endpoint of the same element
  table: string;
  elementId: string;
  side: 'start' | 'end';
  dirPath: string;
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
 * Pre-build step: merge wall endpoints of the same level that lie within 5 cm (in project units) of each other.
 * Modifies GeoJSON files in-place. Returns what was moved.
 */
export function snapEndpoints(dir: string): SnapRecord[] {
  const layout = discoverLayout(dir);
  const tolerance = metersToProject(dir, SNAP_TOLERANCE_M);
  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  const fcCache = new Map<string, BimDownFeatureCollection>(); // key = `${dirPath}/${table}.geojson`
  const snapMap = new Map<string, Point>();
  const records: SnapRecord[] = [];

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const endpoints: EndpointRef[] = [];
    for (const table of BOUNDARY_TABLES) {
      const geomName = GEOJSON_FILE_NAMES[table];
      if (!geomName) continue;
      const path = join(d.path, `${geomName}.geojson`);
      if (!existsSync(path)) continue;

      let fc;
      try { fc = parseGeoJsonFile(path); } catch { continue; }
      fcCache.set(path, fc);

      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const a = f.geometry.coordinates[0];
        const b = f.geometry.coordinates[f.geometry.coordinates.length - 1];
        const pa = { x: a[0], y: a[1] }, pb = { x: b[0], y: b[1] };
        endpoints.push({ point: pa, other: pb, table, elementId: id, side: 'start', dirPath: d.path });
        endpoints.push({ point: pb, other: pa, table, elementId: id, side: 'end', dirPath: d.path });
      }
    }

    // Snapping is per level: endpoints of different levels never interact.
    for (const cluster of clusterEndpoints(endpoints, tolerance)) {
      if (cluster.length <= 1) continue;
      const canonical = pickCanonical(cluster);
      for (const ep of cluster) {
        if (Math.abs(ep.point.x - canonical.x) <= 1e-6 && Math.abs(ep.point.y - canonical.y) <= 1e-6) continue;
        if (turnDegrees(ep.other, ep.point, canonical) > MAX_TURN_DEG) continue;
        snapMap.set(`${ep.dirPath}:${ep.table}:${ep.elementId}:${ep.side}`, canonical);
        records.push({ level: d.name, table: ep.table, elementId: ep.elementId, side: ep.side, from: ep.point, to: canonical });
      }
    }
  }

  if (snapMap.size === 0) return records;

  // Apply snaps by rewriting GeoJSON files
  const dirtyPaths = new Set<string>();
  for (const d of allDirs) {
    for (const table of BOUNDARY_TABLES) {
      const geomName = GEOJSON_FILE_NAMES[table];
      if (!geomName) continue;
      const path = join(d.path, `${geomName}.geojson`);
      const fc = fcCache.get(path);
      if (!fc) continue;

      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
        const id = String(f.properties?.id ?? '');
        const startKey = `${d.path}:${table}:${id}:start`;
        const endKey = `${d.path}:${table}:${id}:end`;
        const ns = snapMap.get(startKey);
        const ne = snapMap.get(endKey);
        if (!ns && !ne) continue;

        const coords = f.geometry.coordinates;
        if (ns) {
          const z = coords[0].length === 3 ? (coords[0] as [number, number, number])[2] : undefined;
          coords[0] = (z !== undefined ? [ns.x, ns.y, z] : [ns.x, ns.y]) as Position;
        }
        if (ne) {
          const last = coords.length - 1;
          const z = coords[last].length === 3 ? (coords[last] as [number, number, number])[2] : undefined;
          coords[last] = (z !== undefined ? [ne.x, ne.y, z] : [ne.x, ne.y]) as Position;
        }
        dirtyPaths.add(path);
      }
    }
  }

  for (const path of dirtyPaths) {
    const fc = fcCache.get(path);
    if (fc) writeFileSync(path, stringifyFeatureCollection(fc), 'utf-8');
  }

  return records;
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

function pickCanonical(cluster: EndpointRef[]): Point {
  const counts = new Map<string, { point: Point; count: number }>();
  for (const ep of cluster) {
    const key = `${ep.point.x.toFixed(4)},${ep.point.y.toFixed(4)}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { point: ep.point, count: 1 });
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
