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
import { buildRegistry, getSpecDir, GEOJSON_FILE_NAMES, ID_PREFIXES } from '../schema/registry.js';
import { mepReport, formatProblem } from '../mep/index.js';

const TOLERANCE = 0.01; // 1cm in meters

const CURVE_TABLES = ['duct', 'pipe', 'cable_tray', 'conduit'];
const NODE_TABLES = ['equipment', 'terminal', 'mep_node'];

/** Which curve tables a connector domain accepts. */
const DOMAIN_TABLES: Record<string, string[]> = {
  hvac: ['duct'],
  piping: ['pipe'],
  electrical: ['conduit', 'cable_tray'],
  cable_tray_conduit: ['conduit', 'cable_tray'],
};

interface Point3D { x: number; y: number; z: number }

interface Curve {
  id: string;
  table: string;
  dir: string;
  row: Record<string, string>;
  feat: BimDownFeature;
  a: Point3D;
  b: Point3D;
}

interface NodeEntry {
  levelDir: string;
  tableName: string;
  id: string;
  pos: Point3D;
  rotation: number;
  system: string;
}

interface ConnectorEntry {
  hostId: string;
  name: string;
  systemType: string;
  domain: string;
  worldPos: Point3D;
}

interface TableFiles {
  csv: CsvData;
  csvPath: string;
  fc: BimDownFeatureCollection;
  geomPath: string;
  dirty: boolean;
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

function systemsCompatible(a: string, b: string): boolean {
  return !a || !b || a === b;
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

/** Parameter + distance of `p` projected on segment a→b (3D). */
function projectOnSegment(p: Point3D, a: Point3D, b: Point3D): { t: number; d: number; at: Point3D } {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return { t: 0, d: dist3d(p, a), at: a };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2));
  const at = { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
  return { t, d: dist3d(p, at), at };
}

const round3 = (n: number) => Number(n.toFixed(4));

/**
 * Connect MEP curves whose ends meet: an end on a connector port becomes
 * `host:port`, an end on an existing node references it, an end on another
 * curve's body splits that curve and adds a tee node, and ends that meet each
 * other get a new passive node. Lone ends stay open (reported afterwards).
 * Only same-table curves join (a duct never joins a pipe), and only when
 * their system types agree (or one is empty).
 */
export function resolveTopology(dir: string): void {
  buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);
  const allDirs = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs];
  const dirPath = (name: string) => (name === 'global' ? layout.globalDir : join(dir, name));

  const files = new Map<string, TableFiles>(); // `${dir}/${table}`
  const openTable = (d: string, table: string): TableFiles => {
    const key = `${d}/${table}`;
    let f = files.get(key);
    if (f) return f;
    const p = dirPath(d);
    const csvPath = join(p, `${table}.csv`);
    const geomPath = join(p, `${GEOJSON_FILE_NAMES[table]}.geojson`);
    let csv: CsvData = existsSync(csvPath) ? readCsv(csvPath) : { headers: ['id', 'number', 'system_type'], rows: [] };
    let fc: BimDownFeatureCollection = { type: 'FeatureCollection', features: [] };
    if (existsSync(geomPath)) {
      try { fc = parseGeoJsonFile(geomPath); } catch { /* keep empty */ }
    }
    if (!csv.headers.includes('id')) csv = { ...csv, headers: ['id', ...csv.headers] };
    f = { csv, csvPath, fc, geomPath, dirty: false };
    files.set(key, f);
    return f;
  };

  // ─── Phase 1: load curves ─────────────────────────────────
  const curves: Curve[] = [];
  const usedIds = new Set<string>();
  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const present = listFiles(d.path);
    // New ids avoid every id and every host a from / to names (a ref to a node
    // on another level must not be captured by a new node here).
    for (const f of present) {
      if (!f.endsWith('.csv')) continue;
      for (const r of readCsv(join(d.path, f)).rows) {
        if (r.id) usedIds.add(r.id);
        for (const ref of [r.from, r.to]) { const h = (ref ?? '').split(':')[0]; if (h) usedIds.add(h); }
      }
    }
    for (const table of CURVE_TABLES) {
      if (!present.includes(`${table}.csv`) || !present.includes(`${GEOJSON_FILE_NAMES[table]}.geojson`)) continue;
      const tf = openTable(d.name, table);
      const geoById = new Map<string, BimDownFeature>();
      for (const feat of tf.fc.features) {
        const id = String(feat.properties?.id ?? '');
        if (id) geoById.set(id, feat);
      }
      for (const row of tf.csv.rows) {
        const feat = geoById.get(row.id);
        if (!feat || feat.geometry.type !== 'LineString') continue;
        const lg = extractLineGeometry(feat);
        curves.push({
          id: row.id, table, dir: d.name, row, feat,
          a: { x: lg.start_x, y: lg.start_y, z: lg.start_z ?? 0 },
          b: { x: lg.end_x, y: lg.end_y, z: lg.end_z ?? 0 },
        });
      }
    }
  }
  const totalCurves = curves.length;
  let alreadyResolved = 0;
  for (const c of curves) {
    if (c.row.from) alreadyResolved++;
    if (c.row.to) alreadyResolved++;
  }

  // ─── Phase 2: load nodes and connectors ───────────────────
  const nodes: NodeEntry[] = [];
  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const present = listFiles(d.path);
    for (const tableName of NODE_TABLES) {
      if (!present.includes(`${tableName}.csv`) || !present.includes(`${GEOJSON_FILE_NAMES[tableName]}.geojson`)) continue;
      const csv = readCsv(join(d.path, `${tableName}.csv`));
      let fc;
      try { fc = parseGeoJsonFile(join(d.path, `${GEOJSON_FILE_NAMES[tableName]}.geojson`)); }
      catch { continue; }
      const posById = new Map<string, { pos: Point3D; rotation: number }>();
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const pg = extractPointGeometry(f);
        posById.set(id, { pos: { x: pg.x, y: pg.y, z: pg.z ?? 0 }, rotation: toFloat(f.properties?.rotation) });
      }
      for (const row of csv.rows) {
        const p = posById.get(row.id);
        if (!p) continue;
        nodes.push({ levelDir: d.name, tableName, id: row.id, pos: p.pos, rotation: p.rotation, system: row.system_type ?? '' });
      }
    }
  }
  // Ids are unique per level: a connector's host is in its own directory (or global/).
  const nodeByKey = new Map(nodes.map(n => [`${n.levelDir}/${n.id}`, n]));
  const connectors: ConnectorEntry[] = [];
  for (const d of allDirs) {
    if (!existsSync(d.path) || !listFiles(d.path).includes('connector.csv')) continue;
    for (const row of readCsv(join(d.path, 'connector.csv')).rows) {
      const host = nodeByKey.get(`${d.name}/${row.host_id ?? ''}`) ?? nodeByKey.get(`global/${row.host_id ?? ''}`);
      if (!host || !row.name) continue;
      connectors.push({
        hostId: row.host_id, name: row.name, systemType: row.system_type ?? '',
        domain: row.domain ?? '', worldPos: connectorWorldPos(host, row),
      });
    }
  }

  const nextId = (table: string): string => {
    const prefix = ID_PREFIXES[table];
    let n = 1;
    while (usedIds.has(`${prefix}-${n}`)) n++;
    const id = `${prefix}-${n}`;
    usedIds.add(id);
    return id;
  };

  const newNodes: { id: string; dir: string; pos: Point3D; system: string }[] = [];
  const addNode = (d: string, pos: Point3D, system: string): string => {
    const id = nextId('mep_node');
    newNodes.push({ id, dir: d, pos, system });
    nodes.push({ levelDir: d, tableName: 'mep_node', id, pos, rotation: 0, system });
    return id;
  };
  const setRef = (c: Curve, side: 'from' | 'to', ref: string) => {
    if (!openTable(c.dir, c.table).csv.headers.includes(side)) openTable(c.dir, c.table).csv.headers.push(side);
    c.row[side] = ref;
    openTable(c.dir, c.table).dirty = true;
  };

  // ─── Phase 3: each free end → port, node, or another curve's body ──
  let portMatches = 0, nodeMatches = 0, tees = 0;
  const stillFree: { c: Curve; side: 'from' | 'to' }[] = [];
  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci];
    for (const side of ['from', 'to'] as const) {
      if (c.row[side]) continue;
      const p = side === 'from' ? c.a : c.b;
      const sys = c.row.system_type ?? '';

      // a. Connector port (prefer the same system when several coincide).
      let best: ConnectorEntry | null = null;
      let bestD = Infinity;
      for (const cn of connectors) {
        const allowed = DOMAIN_TABLES[cn.domain];
        if (allowed && !allowed.includes(c.table)) continue;
        const d = dist3d(p, cn.worldPos);
        if (d > TOLERANCE) continue;
        const better = d < bestD - 1e-9 || (sys && cn.systemType === sys && best?.systemType !== sys);
        if (!best || better) { best = cn; bestD = d; }
      }
      if (best) { setRef(c, side, `${best.hostId}:${best.name}`); portMatches++; continue; }

      // b. Existing node at the end.
      const node = nodes.find(n => near(p, n.pos) && (n.tableName !== 'mep_node' || systemsCompatible(n.system, sys)));
      if (node) { setRef(c, side, node.id); nodeMatches++; continue; }

      // c. End on another curve's body (same table and system): split it, add a tee.
      let hit: { other: Curve; at: Point3D } | null = null;
      for (const other of curves) {
        if (other === c || other.table !== c.table || other.feat.properties?.arc) continue;
        if (!systemsCompatible(other.row.system_type ?? '', sys)) continue;
        const pr = projectOnSegment(p, other.a, other.b);
        if (pr.d > TOLERANCE) continue;
        if (dist3d(pr.at, other.a) <= TOLERANCE || dist3d(pr.at, other.b) <= TOLERANCE) continue;
        hit = { other, at: pr.at };
        break;
      }
      if (hit) {
        const { other, at } = hit;
        const nodeId = addNode(other.dir, at, other.row.system_type || sys);
        const tf = openTable(other.dir, other.table);
        const newId = nextId(other.table);
        const newRow: Record<string, string> = { ...other.row, id: newId, from: nodeId, to: other.row.to ?? '' };
        for (const h of ['from', 'to']) if (!tf.csv.headers.includes(h)) tf.csv.headers.push(h);
        tf.csv.rows.push(newRow);
        other.row.to = nodeId;
        const coords = (other.feat.geometry as { coordinates: number[][] }).coordinates;
        const end = coords[coords.length - 1];
        const mid = [round3(at.x), round3(at.y), round3(at.z)];
        (other.feat.geometry as { coordinates: number[][] }).coordinates = [coords[0], mid];
        const newFeat: BimDownFeature = {
          type: 'Feature',
          properties: { ...other.feat.properties, id: newId },
          geometry: { type: 'LineString', coordinates: [mid, end] },
        } as BimDownFeature;
        tf.fc.features.push(newFeat);
        tf.dirty = true;
        curves.push({ id: newId, table: other.table, dir: other.dir, row: newRow, feat: newFeat, a: { ...at }, b: { ...other.b } });
        other.b = { ...at };
        setRef(c, side, nodeId);
        tees++;
        continue;
      }
      stillFree.push({ c, side });
    }
  }

  // ─── Phase 4: ends that meet each other → one passive node ──
  interface Junction { point: Point3D; ends: { c: Curve; side: 'from' | 'to' }[] }
  const junctions: Junction[] = [];
  for (const ep of stillFree) {
    if (ep.c.row[ep.side]) continue;
    const p = ep.side === 'from' ? ep.c.a : ep.c.b;
    const sys = ep.c.row.system_type ?? '';
    const j = junctions.find(j => near(p, j.point) && j.ends[0].c.table === ep.c.table
      && systemsCompatible(j.ends[0].c.row.system_type ?? '', sys));
    if (j) j.ends.push(ep);
    else junctions.push({ point: p, ends: [ep] });
  }
  let created = tees;
  for (const j of junctions) {
    if (j.ends.length < 2) continue; // a lone end stays open — the check reports it
    const sys = j.ends.map(e => e.c.row.system_type).find(Boolean) ?? '';
    const nodeId = addNode(j.ends[0].c.dir, j.point, sys);
    for (const e of j.ends) setRef(e.c, e.side, nodeId);
    created++;
  }

  // ─── Phase 5: write new mep_node rows + split curves ──────
  for (const n of newNodes) {
    const d = dirPath(n.dir);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const tf = openTable(n.dir, 'mep_node');
    for (const h of ['id', 'number', 'system_type']) if (!tf.csv.headers.includes(h)) tf.csv.headers.push(h);
    tf.csv.rows.push({ id: n.id, number: '', system_type: n.system });
    tf.fc.features.push({
      type: 'Feature',
      properties: { id: n.id },
      geometry: { type: 'Point', coordinates: [round3(n.pos.x), round3(n.pos.y), round3(n.pos.z)] },
    } as BimDownFeature);
    tf.dirty = true;
  }
  let written = 0;
  for (const tf of files.values()) {
    if (!tf.dirty) continue;
    writeCsv(tf.csvPath, tf.csv);
    writeFileSync(tf.geomPath, stringifyFeatureCollection(tf.fc), 'utf-8');
    written++;
  }

  console.log(`Scanned ${totalCurves} MEP curves (${totalCurves * 2} endpoints)`);
  console.log(`  Already connected: ${alreadyResolved}`);
  console.log(`  Connected to ports: ${portMatches}, to existing nodes: ${nodeMatches}`);
  console.log(`  Tees from ends on a curve body: ${tees} (curves split)`);
  console.log(`  New mep_nodes created: ${created}`);
  if (written > 0) console.log(`Updated ${written} file(s)`);

  const problems = mepReport(dir).problems.filter(p => p.severity === 'warning');
  if (problems.length === 0) {
    console.log('MEP connectivity: no problems.');
  } else {
    console.log(`\n${problems.length} connectivity problem(s):`);
    for (const p of problems.slice(0, 30)) console.log(`  ${formatProblem(p)}`);
    if (problems.length > 30) console.log(`  ... ${problems.length - 30} more (bimdown mep-check <dir>)`);
  }
}
