import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv, writeCsv, type CsvData } from '../utils/csv.js';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  extractLineGeometry,
  extractPointGeometry,
  type BimDownFeature,
  type BimDownFeatureCollection,
} from '../utils/geojson.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { buildRegistry, getSpecDir, GEOJSON_FILE_NAMES } from '../schema/registry.js';

const TOLERANCE = 0.01; // 1cm in meters

const CURVE_TABLES = ['duct', 'pipe', 'cable_tray', 'conduit'];
const NODE_TABLES = ['equipment', 'terminal', 'mep_node'];

interface Point3D { x: number; y: number; z: number }

interface CurveEndpoint {
  curveId: string;
  side: 'start' | 'end';
  point: Point3D;
  levelDir: string;
  systemType: string;
}

interface NodeEntry {
  levelDir: string;
  tableName: string;
  id: string;
  pos: Point3D;
}

function dist3d(a: Point3D, b: Point3D): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function near(a: Point3D, b: Point3D): boolean {
  return dist3d(a, b) <= TOLERANCE;
}

export function resolveTopology(dir: string): void {
  buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);

  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  // ─── Phase 1: load curves, collect free endpoints ─────────
  const freeEndpoints: CurveEndpoint[] = [];
  const curveData = new Map<string, { csv: CsvData; path: string }>();
  let totalCurves = 0;
  let alreadyResolved = 0;

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);

    for (const tableName of CURVE_TABLES) {
      if (!files.includes(`${tableName}.csv`)) continue;
      const geomName = GEOJSON_FILE_NAMES[tableName];
      if (!geomName || !files.includes(`${geomName}.geojson`)) continue;

      const csvPath = join(d.path, `${tableName}.csv`);
      const geomPath = join(d.path, `${geomName}.geojson`);
      const csv = readCsv(csvPath);
      const key = `${d.name}/${tableName}`;
      curveData.set(key, { csv, path: csvPath });

      let fc;
      try { fc = parseGeoJsonFile(geomPath); }
      catch { continue; }

      const geoById = new Map<string, BimDownFeature>();
      for (const f of fc.features) {
        const id = String(f.properties?.id ?? '');
        if (id) geoById.set(id, f);
      }

      for (const row of csv.rows) {
        const feat = geoById.get(row.id);
        if (!feat || feat.geometry.type !== 'LineString') continue;
        totalCurves++;
        const lg = extractLineGeometry(feat);

        if (row.start_node_id) alreadyResolved++;
        else freeEndpoints.push({
          curveId: row.id, side: 'start',
          point: { x: lg.start_x, y: lg.start_y, z: lg.start_z ?? 0 },
          levelDir: d.name, systemType: row.system_type ?? '',
        });

        if (row.end_node_id) alreadyResolved++;
        else freeEndpoints.push({
          curveId: row.id, side: 'end',
          point: { x: lg.end_x, y: lg.end_y, z: lg.end_z ?? 0 },
          levelDir: d.name, systemType: row.system_type ?? '',
        });
      }
    }
  }

  // ─── Phase 2: load existing nodes ─────────────────────────
  const nodes: NodeEntry[] = [];

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);

    for (const tableName of NODE_TABLES) {
      if (!files.includes(`${tableName}.csv`)) continue;
      const geomName = GEOJSON_FILE_NAMES[tableName];
      if (!geomName || !files.includes(`${geomName}.geojson`)) continue;

      const geomPath = join(d.path, `${geomName}.geojson`);
      const csvPath = join(d.path, `${tableName}.csv`);
      const csv = readCsv(csvPath);

      let fc;
      try { fc = parseGeoJsonFile(geomPath); }
      catch { continue; }

      const posById = new Map<string, Point3D>();
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const pg = extractPointGeometry(f);
        posById.set(id, { x: pg.x, y: pg.y, z: pg.z ?? 0 });
      }

      for (const row of csv.rows) {
        const p = posById.get(row.id);
        if (!p) continue;
        nodes.push({ levelDir: d.name, tableName, id: row.id, pos: p });
      }
    }
  }

  // ─── Phase 3: match free endpoints to existing nodes ──────
  const resolvedIds = new Map<string, string>();
  const stillFree: CurveEndpoint[] = [];

  for (const ep of freeEndpoints) {
    let matched: NodeEntry | null = null;
    for (const node of nodes) {
      if (near(ep.point, node.pos)) { matched = node; break; }
    }
    if (matched) resolvedIds.set(`${ep.curveId}:${ep.side}`, matched.id);
    else stillFree.push(ep);
  }
  const fittingMatches = resolvedIds.size;

  // ─── Phase 4: cluster remaining endpoints into new mep_nodes ──
  interface Junction {
    point: Point3D;
    endpoints: CurveEndpoint[];
    nodeId: string;
    levelDir: string;
    systemType: string;
  }
  const junctions: Junction[] = [];
  for (const ep of stillFree) {
    let found = false;
    for (const j of junctions) {
      if (near(ep.point, j.point)) { j.endpoints.push(ep); found = true; break; }
    }
    if (!found) junctions.push({
      point: ep.point, endpoints: [ep], nodeId: '',
      levelDir: ep.levelDir, systemType: ep.systemType,
    });
  }

  // Allocate mep-node IDs per level
  const maxMnId = new Map<string, number>();
  for (const n of nodes) {
    if (n.tableName !== 'mep_node') continue;
    const m = n.id.match(/^mn-(\d+)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const cur = maxMnId.get(n.levelDir) ?? 0;
    if (num > cur) maxMnId.set(n.levelDir, num);
  }
  for (const j of junctions) {
    const cur = maxMnId.get(j.levelDir) ?? 0;
    const next = cur + 1;
    maxMnId.set(j.levelDir, next);
    j.nodeId = `mn-${next}`;
    for (const ep of j.endpoints) resolvedIds.set(`${ep.curveId}:${ep.side}`, j.nodeId);
  }

  // ─── Phase 5: write new mep_node entries (CSV + GeoJSON) ──
  const newByLevel = new Map<string, Junction[]>();
  for (const j of junctions) {
    const arr = newByLevel.get(j.levelDir) ?? [];
    arr.push(j);
    newByLevel.set(j.levelDir, arr);
  }

  for (const [levelDir, jns] of newByLevel) {
    const dirPath = levelDir === 'global' ? layout.globalDir : join(dir, levelDir);
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

    const csvPath = join(dirPath, 'mep_node.csv');
    const geomPath = join(dirPath, 'mep_node.geojson');

    // CSV: append new mep_node rows (base_offset moved to GeoJSON properties now, so no Z column needed)
    let csv: CsvData;
    if (existsSync(csvPath)) csv = readCsv(csvPath);
    else csv = { headers: ['id', 'number', 'system_type'], rows: [] };
    for (const h of ['id', 'number', 'system_type']) {
      if (!csv.headers.includes(h)) csv.headers.push(h);
    }
    for (const j of jns) {
      csv.rows.push({ id: j.nodeId, number: '', system_type: j.systemType });
    }
    writeCsv(csvPath, csv);

    // GeoJSON: append new Point features (3D, mep_node is spatial)
    let fc: BimDownFeatureCollection;
    if (existsSync(geomPath)) {
      try { fc = parseGeoJsonFile(geomPath); }
      catch { fc = { type: 'FeatureCollection', features: [] }; }
    } else {
      fc = { type: 'FeatureCollection', features: [] };
    }
    for (const j of jns) {
      fc.features.push({
        type: 'Feature',
        properties: { id: j.nodeId },
        geometry: { type: 'Point', coordinates: [j.point.x, j.point.y, j.point.z] },
      });
    }
    writeFileSync(geomPath, stringifyFeatureCollection(fc), 'utf-8');
  }

  // ─── Phase 6: back-fill curve CSV node IDs ────────────────
  let updatedRows = 0;
  for (const [, entry] of curveData) {
    let modified = false;
    if (!entry.csv.headers.includes('start_node_id')) entry.csv.headers.push('start_node_id');
    if (!entry.csv.headers.includes('end_node_id')) entry.csv.headers.push('end_node_id');
    for (const row of entry.csv.rows) {
      if (!row.start_node_id) {
        const id = resolvedIds.get(`${row.id}:start`);
        if (id) { row.start_node_id = id; modified = true; updatedRows++; }
      }
      if (!row.end_node_id) {
        const id = resolvedIds.get(`${row.id}:end`);
        if (id) { row.end_node_id = id; modified = true; }
      }
    }
    if (modified) writeCsv(entry.path, entry.csv);
  }

  console.log(`Scanned ${totalCurves} MEP curves (${totalCurves * 2} endpoints)`);
  console.log(`  Already connected: ${alreadyResolved} (from Revit export)`);
  console.log(`  Free endpoints: ${freeEndpoints.length}`);
  console.log(`  Matched to existing nodes (proximity): ${fittingMatches}`);
  console.log(`  New mep_nodes created: ${junctions.length}`);
  if (updatedRows > 0) console.log(`Updated ${updatedRows} curve rows`);
}
