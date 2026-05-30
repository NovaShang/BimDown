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
  side: 'from' | 'to';
  point: Point3D;
  levelDir: string;
  systemType: string;
}

interface NodeEntry {
  levelDir: string;
  tableName: string;
  id: string;
  pos: Point3D;
  rotation: number;
}

interface ConnectorEntry {
  hostId: string;
  name: string;
  systemType: string;
  worldPos: Point3D;
}

function dist3d(a: Point3D, b: Point3D): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function near(a: Point3D, b: Point3D): boolean {
  return dist3d(a, b) <= TOLERANCE;
}

function toFloat(val: unknown, fallback = 0): number {
  const n = parseFloat(String(val ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve a connector row to its world position given its host node's pos + rotation. */
function connectorWorldPos(node: NodeEntry, row: Record<string, string>): Point3D {
  const ox = toFloat(row.offset_x);
  const oy = toFloat(row.offset_y);
  const oz = toFloat(row.offset_z);
  const theta = (node.rotation * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    x: node.pos.x + (ox * c - oy * s),
    y: node.pos.y + (ox * s + oy * c),
    z: node.pos.z + oz,
  };
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

        if (row.from) alreadyResolved++;
        else freeEndpoints.push({
          curveId: row.id, side: 'from',
          point: { x: lg.start_x, y: lg.start_y, z: lg.start_z ?? 0 },
          levelDir: d.name, systemType: row.system_type ?? '',
        });

        if (row.to) alreadyResolved++;
        else freeEndpoints.push({
          curveId: row.id, side: 'to',
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

      const posById = new Map<string, { pos: Point3D; rotation: number }>();
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const pg = extractPointGeometry(f);
        const rotation = toFloat(f.properties?.rotation);
        posById.set(id, { pos: { x: pg.x, y: pg.y, z: pg.z ?? 0 }, rotation });
      }

      for (const row of csv.rows) {
        const p = posById.get(row.id);
        if (!p) continue;
        nodes.push({ levelDir: d.name, tableName, id: row.id, pos: p.pos, rotation: p.rotation });
      }
    }
  }

  // ─── Phase 2b: load connectors (host_id, name, world pos) ─
  const nodeById = new Map<string, NodeEntry>();
  for (const n of nodes) nodeById.set(n.id, n);

  const connectorsByHost = new Map<string, ConnectorEntry[]>();
  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);
    if (!files.includes('connector.csv')) continue;
    const csv = readCsv(join(d.path, 'connector.csv'));
    for (const row of csv.rows) {
      const host = nodeById.get(row.host_id ?? '');
      if (!host || !row.name) continue;
      const entry: ConnectorEntry = {
        hostId: row.host_id,
        name: row.name,
        systemType: row.system_type ?? '',
        worldPos: connectorWorldPos(host, row),
      };
      const arr = connectorsByHost.get(row.host_id) ?? [];
      arr.push(entry);
      connectorsByHost.set(row.host_id, arr);
    }
  }

  // ─── Phase 3: match free endpoints to existing nodes / ports ──
  const resolvedRefs = new Map<string, string>(); // "curveId:side" -> port_ref string
  const stillFree: CurveEndpoint[] = [];

  for (const ep of freeEndpoints) {
    // Try connector match first (more specific than node match)
    let bestConn: ConnectorEntry | null = null;
    let bestConnDist = Infinity;
    for (const arr of connectorsByHost.values()) {
      for (const c of arr) {
        const d = dist3d(ep.point, c.worldPos);
        if (d <= TOLERANCE && d < bestConnDist) {
          // prefer matching system_type when distances are tied
          if (
            bestConn === null ||
            d < bestConnDist - 1e-9 ||
            (ep.systemType && c.systemType === ep.systemType && bestConn.systemType !== ep.systemType)
          ) {
            bestConn = c;
            bestConnDist = d;
          }
        }
      }
    }
    if (bestConn) {
      resolvedRefs.set(`${ep.curveId}:${ep.side}`, `${bestConn.hostId}:${bestConn.name}`);
      continue;
    }
    // Fallback to node host match
    let matched: NodeEntry | null = null;
    for (const node of nodes) {
      if (near(ep.point, node.pos)) { matched = node; break; }
    }
    if (matched) resolvedRefs.set(`${ep.curveId}:${ep.side}`, matched.id);
    else stillFree.push(ep);
  }
  const fittingMatches = resolvedRefs.size;

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
    // Junctions are passive mep_nodes; reference by bare host_id (no :port suffix)
    for (const ep of j.endpoints) resolvedRefs.set(`${ep.curveId}:${ep.side}`, j.nodeId);
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

  // ─── Phase 6: back-fill curve CSV from/to columns ──────────
  let updatedRows = 0;
  for (const [, entry] of curveData) {
    let modified = false;
    if (!entry.csv.headers.includes('from')) entry.csv.headers.push('from');
    if (!entry.csv.headers.includes('to')) entry.csv.headers.push('to');
    for (const row of entry.csv.rows) {
      if (!row.from) {
        const ref = resolvedRefs.get(`${row.id}:from`);
        if (ref) { row.from = ref; modified = true; updatedRows++; }
      }
      if (!row.to) {
        const ref = resolvedRefs.get(`${row.id}:to`);
        if (ref) { row.to = ref; modified = true; }
      }
    }
    if (modified) writeCsv(entry.path, entry.csv);
  }

  console.log(`Scanned ${totalCurves} MEP curves (${totalCurves * 2} endpoints)`);
  console.log(`  Already connected: ${alreadyResolved}`);
  console.log(`  Free endpoints: ${freeEndpoints.length}`);
  console.log(`  Matched to existing nodes/ports: ${fittingMatches}`);
  console.log(`  New mep_nodes created: ${junctions.length}`);
  if (updatedRows > 0) console.log(`Updated ${updatedRows} curve rows`);
}
