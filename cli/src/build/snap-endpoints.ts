import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  type BimDownFeatureCollection,
  type Position,
} from '../utils/geojson.js';
import { writeFileSync } from 'node:fs';
import { readCsv } from '../utils/csv.js';
import { discoverLayout } from '../utils/fs.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';

const MIN_SNAP_TOLERANCE = 0.10; // 10cm floor

const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];
const WALL_TABLES_WITH_THICKNESS = ['wall', 'structure_wall', 'curtain_wall'];

interface Point { x: number; y: number }

interface EndpointRef {
  point: Point;
  table: string;
  elementId: string;
  side: 'start' | 'end';
  dirPath: string;
}

/**
 * Pre-build step: snap wall endpoints that are within SNAP_TOLERANCE of each other.
 * Modifies GeoJSON files in-place. Returns count of snapped endpoints.
 */
export function snapEndpoints(dir: string): number {
  const layout = discoverLayout(dir);
  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  const snapTolerance = computeSnapTolerance(allDirs);

  // Collect all endpoints
  const allEndpoints: EndpointRef[] = [];
  const fcCache = new Map<string, BimDownFeatureCollection>(); // key = `${dirPath}/${table}.geojson`

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
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
        allEndpoints.push({ point: { x: a[0], y: a[1] }, table, elementId: id, side: 'start', dirPath: d.path });
        allEndpoints.push({ point: { x: b[0], y: b[1] }, table, elementId: id, side: 'end', dirPath: d.path });
      }
    }
  }

  if (allEndpoints.length === 0) return 0;

  const clusters = clusterEndpoints(allEndpoints, snapTolerance);
  const snapMap = new Map<string, Point>();
  let totalSnapped = 0;

  for (const cluster of clusters) {
    if (cluster.length <= 1) continue;
    const canonical = pickCanonical(cluster);
    for (const ep of cluster) {
      if (Math.abs(ep.point.x - canonical.x) > 1e-6 || Math.abs(ep.point.y - canonical.y) > 1e-6) {
        const key = `${ep.dirPath}:${ep.table}:${ep.elementId}:${ep.side}`;
        snapMap.set(key, canonical);
        totalSnapped++;
      }
    }
  }

  if (snapMap.size === 0) return 0;

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

  return totalSnapped;
}

function computeSnapTolerance(dirs: { name: string; path: string }[]): number {
  let maxThickness = 0;
  for (const d of dirs) {
    if (!existsSync(d.path)) continue;
    for (const table of WALL_TABLES_WITH_THICKNESS) {
      const csvPath = join(d.path, `${table}.csv`);
      if (!existsSync(csvPath)) continue;
      try {
        const csv = readCsv(csvPath);
        for (const row of csv.rows) {
          const t = parseFloat(row.thickness ?? '0');
          if (t > maxThickness) maxThickness = t;
        }
      } catch { /* skip */ }
    }
  }
  return Math.max(MIN_SNAP_TOLERANCE, maxThickness);
}

function clusterEndpoints(endpoints: EndpointRef[], tolerance: number): EndpointRef[][] {
  const visited = new Set<number>();
  const clusters: EndpointRef[][] = [];

  for (let i = 0; i < endpoints.length; i++) {
    if (visited.has(i)) continue;
    const cluster: EndpointRef[] = [endpoints[i]];
    visited.add(i);

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let j = 0; j < endpoints.length; j++) {
        if (visited.has(j)) continue;
        for (const member of cluster) {
          if (dist(member.point, endpoints[j].point) < tolerance) {
            cluster.push(endpoints[j]);
            visited.add(j);
            expanded = true;
            break;
          }
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
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
