/**
 * Migrate a BimDown project from SVG geometry (format_version 1) to GeoJSON
 * geometry (format_version 2).
 *
 * Per-table transformation:
 *   - {table}.svg → {table}.geojson (FeatureCollection)
 *   - {table}.csv loses Z-related columns: base_offset, top_offset, height_offset,
 *     start_z, end_z (folded into GeoJSON properties or 3D coordinates)
 *
 * Per-element transformation:
 *   - <path d="M x,y L x,y"> → LineString (2D for level-anchored, 3D with absolute Z for spatial)
 *   - <path d="M x,y A r,r ... x,y"> → LineString (2 points) + properties.arc
 *   - <rect>/<circle> → Point + properties.rotation (only if non-zero rotation)
 *   - <polygon> → Polygon (closed ring)
 *
 * Z handling:
 *   - Level-anchored elements: base_offset/top_offset/height_offset → GeoJSON properties; geometry stays 2D
 *   - Spatial line elements (beam, brace, stair, ramp, railing, MEP curves):
 *       start_z/end_z (already absolute in CSV) become 3D LineString coordinates
 *   - Spatial point elements (equipment, terminal, mep_node):
 *       z = level.elevation + base_offset; base_offset is consumed
 *
 * Run:
 *   npx tsx scripts/svg-to-geojson.ts <project_dir>
 *   npx tsx scripts/svg-to-geojson.ts sample_data/rac_advanced
 */
import { existsSync, readdirSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { readCsv, writeCsv, type CsvData } from '../cli/src/utils/csv.js';
import { parseSvgFile, extractLineGeometry, extractRectGeometry, extractPolygonGeometry, extractCircleGeometry, type SvgElement } from '../cli/src/utils/svg.js';
import {
  type BimDownFeature,
  type BimDownFeatureCollection,
  type GeoJsonGeometry,
  type ArcParams,
  stringifyFeatureCollection,
} from '../cli/src/utils/geojson.js';
import { SPATIAL_3D_TABLES, GEOJSON_FILE_NAMES, ID_PREFIXES } from '../cli/src/schema/registry.js';

const Z_FIELDS_TO_MOVE = ['base_offset', 'top_offset', 'height_offset', 'start_z', 'end_z'];

interface LevelInfo {
  id: string;
  elevation: number;
}

interface MigrationContext {
  projectDir: string;
  levels: Map<string, LevelInfo>;
}

// ─── Entry point ──────────────────────────────────────────

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: tsx scripts/svg-to-geojson.ts <project_dir>');
    process.exit(1);
  }
  const projectDir = resolve(arg);
  if (!existsSync(projectDir)) {
    console.error(`Directory not found: ${projectDir}`);
    process.exit(1);
  }

  const levels = loadLevels(projectDir);
  const ctx: MigrationContext = { projectDir, levels };

  let svgCount = 0;
  let geojsonCount = 0;

  // Process each directory: global/ + each lv-*/
  for (const dir of discoverDirs(projectDir)) {
    const dirName = basename(dir);
    const processed = new Set<string>();

    // (1) Migrate tables that have an SVG file
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.svg')) continue;
      const tableName = file.replace('.svg', '');
      if (!GEOJSON_FILE_NAMES[tableName]) continue;
      const csvPath = join(dir, `${tableName}.csv`);
      if (!existsSync(csvPath)) {
        console.warn(`  skip ${dirName}/${file}: no matching CSV`);
        continue;
      }
      svgCount++;
      const result = migrateOne(ctx, dir, tableName);
      if (result) {
        geojsonCount++;
        processed.add(tableName);
        console.log(`  ${dirName}/${tableName}: ${result.features} feature(s) → ${tableName}.geojson; CSV columns -${result.removed.join(',') || '(none)'}`);
      }
    }

    // (2) Strip Z-related columns from any remaining CSVs (orphan geometry, CSV-only tables, etc.)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.csv')) continue;
      const tableName = file.replace('.csv', '');
      if (processed.has(tableName)) continue;
      const csvPath = join(dir, file);
      const removed = stripZColumns(csvPath);
      if (removed.length > 0) {
        console.log(`  ${dirName}/${tableName}: CSV columns -${removed.join(',')} (no SVG to migrate)`);
      }
    }
  }

  // Bump format_version in project_metadata.json
  const metaPath = join(projectDir, 'project_metadata.json');
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    meta.format_version = 2;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    console.log(`\nproject_metadata.json: format_version → 2`);
  }

  console.log(`\nMigrated ${geojsonCount}/${svgCount} SVG files to GeoJSON.`);
}

// ─── Per-table migration ──────────────────────────────────

function migrateOne(ctx: MigrationContext, dir: string, tableName: string):
  | { features: number; removed: string[] }
  | null {
  const svgPath = join(dir, `${tableName}.svg`);
  const csvPath = join(dir, `${tableName}.csv`);
  const geojsonPath = join(dir, `${tableName}.geojson`);

  const svg = parseSvgFile(svgPath);
  const csv = readCsv(csvPath);

  // Index SVG by id
  const svgById = new Map<string, SvgElement>();
  for (const el of svg.elements) {
    if (el.id) svgById.set(el.id, el);
  }

  // Determine base level from directory name (for spatial point Z computation)
  const dirName = basename(dir);
  const baseLevel = ctx.levels.get(dirName === 'global' ? firstLevelId(ctx) : dirName);

  const isSpatial = SPATIAL_3D_TABLES.has(tableName);
  const features: BimDownFeature[] = [];

  for (const row of csv.rows) {
    const id = row.id;
    if (!id) continue;
    const el = svgById.get(id);
    if (!el) {
      console.warn(`    row ${id}: no SVG element, skipping`);
      continue;
    }

    const feature = buildFeature(tableName, id, row, el, isSpatial, baseLevel);
    if (feature) features.push(feature);
  }

  // Write GeoJSON
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  writeFileSync(geojsonPath, stringifyFeatureCollection(fc), 'utf-8');

  // Rewrite CSV without moved columns
  const removed: string[] = [];
  const newHeaders = csv.headers.filter((h) => {
    if (Z_FIELDS_TO_MOVE.includes(h)) {
      removed.push(h);
      return false;
    }
    return true;
  });
  const newCsv: CsvData = {
    headers: newHeaders,
    rows: csv.rows.map((r) => {
      const out: Record<string, string> = {};
      for (const h of newHeaders) out[h] = r[h] ?? '';
      return out;
    }),
  };
  writeCsv(csvPath, newCsv);

  // Delete the old SVG
  unlinkSync(svgPath);

  return { features: features.length, removed };
}

// ─── Feature construction ─────────────────────────────────

function buildFeature(
  tableName: string,
  id: string,
  row: Record<string, string>,
  el: SvgElement,
  isSpatial: boolean,
  baseLevel: LevelInfo | undefined,
): BimDownFeature | null {
  const geometry = buildGeometry(tableName, row, el, isSpatial, baseLevel);
  if (!geometry) return null;

  const properties: Record<string, unknown> = { id };

  // Carry Z props for level-anchored elements
  if (!isSpatial) {
    const baseOffset = parseOptionalFloat(row.base_offset);
    if (baseOffset !== undefined && baseOffset !== 0) properties.base_offset = baseOffset;
    const topOffset = parseOptionalFloat(row.top_offset);
    if (topOffset !== undefined && topOffset !== 0) properties.top_offset = topOffset;
    const heightOffset = parseOptionalFloat(row.height_offset);
    if (heightOffset !== undefined) properties.height_offset = heightOffset;
  }

  // Rotation for point elements with SVG transform
  if (el.tag === 'rect' || el.tag === 'circle') {
    const r = extractRotation(el);
    if (r !== 0) properties.rotation = r;
  }

  // Arc detection for path with A command
  if (el.tag === 'path') {
    const arc = extractArcParams(el);
    if (arc) properties.arc = arc;
  }

  return { type: 'Feature', properties: properties as any, geometry };
}

function buildGeometry(
  tableName: string,
  row: Record<string, string>,
  el: SvgElement,
  isSpatial: boolean,
  baseLevel: LevelInfo | undefined,
): GeoJsonGeometry | null {
  switch (el.tag) {
    case 'path': {
      const g = extractLineGeometry(el);
      if (isSpatial) {
        const zStart = parseOptionalFloat(row.start_z);
        const zEnd = parseOptionalFloat(row.end_z);
        const z0 = zStart !== undefined ? zStart : (baseLevel?.elevation ?? 0) + (parseOptionalFloat(row.base_offset) ?? 0);
        const z1 = zEnd !== undefined ? zEnd : z0;
        return { type: 'LineString', coordinates: [[g.start_x, g.start_y, z0], [g.end_x, g.end_y, z1]] };
      }
      return { type: 'LineString', coordinates: [[g.start_x, g.start_y], [g.end_x, g.end_y]] };
    }
    case 'rect': {
      const g = extractRectGeometry(el);
      if (isSpatial) {
        const z = (baseLevel?.elevation ?? 0) + (parseOptionalFloat(row.base_offset) ?? 0);
        return { type: 'Point', coordinates: [g.x, g.y, z] };
      }
      return { type: 'Point', coordinates: [g.x, g.y] };
    }
    case 'circle': {
      const g = extractCircleGeometry(el);
      if (isSpatial) {
        const z = (baseLevel?.elevation ?? 0) + (parseOptionalFloat(row.base_offset) ?? 0);
        return { type: 'Point', coordinates: [g.x, g.y, z] };
      }
      return { type: 'Point', coordinates: [g.x, g.y] };
    }
    case 'polygon': {
      const pts = parsePolygonPoints(el.attrs.points ?? '');
      if (pts.length < 3) return null;
      // Close the ring (GeoJSON requires first == last)
      const ring: [number, number][] = pts.map((p) => [p.x, p.y]);
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
      return { type: 'Polygon', coordinates: [ring] };
    }
    default:
      return null;
  }
}

function stripZColumns(csvPath: string): string[] {
  const csv = readCsv(csvPath);
  const removed: string[] = [];
  const newHeaders = csv.headers.filter((h) => {
    if (Z_FIELDS_TO_MOVE.includes(h)) {
      removed.push(h);
      return false;
    }
    return true;
  });
  if (removed.length === 0) return removed;
  const newCsv: CsvData = {
    headers: newHeaders,
    rows: csv.rows.map((r) => {
      const out: Record<string, string> = {};
      for (const h of newHeaders) out[h] = r[h] ?? '';
      return out;
    }),
  };
  writeCsv(csvPath, newCsv);
  return removed;
}

// ─── Helpers ──────────────────────────────────────────────

function parseOptionalFloat(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

function parsePolygonPoints(s: string): { x: number; y: number }[] {
  return s.trim().split(/\s+/).filter(Boolean).map((p) => {
    const [x, y] = p.split(',').map(Number);
    return { x: x ?? 0, y: y ?? 0 };
  });
}

function extractRotation(el: SvgElement): number {
  const t = el.attrs.transform;
  if (!t) return 0;
  const m = t.match(/rotate\(([^,)]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function extractArcParams(el: SvgElement): ArcParams | undefined {
  const d = el.attrs.d ?? '';
  // Match "A rx,ry rot large_arc,sweep x,y" or with spaces
  const m = d.match(/A\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+([01])[,\s]+([01])[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
  if (!m) return undefined;
  return {
    radius: parseFloat(m[1]),
    large_arc: m[4] === '1',
    sweep: m[5] === '1',
  };
}

function loadLevels(projectDir: string): Map<string, LevelInfo> {
  const levels = new Map<string, LevelInfo>();
  const levelCsv = join(projectDir, 'global', 'level.csv');
  if (!existsSync(levelCsv)) return levels;
  const csv = readCsv(levelCsv);
  for (const row of csv.rows) {
    levels.set(row.id, { id: row.id, elevation: parseFloat(row.elevation || '0') });
  }
  return levels;
}

function firstLevelId(ctx: MigrationContext): string {
  let lowest: LevelInfo | undefined;
  for (const lv of ctx.levels.values()) {
    if (!lowest || lv.elevation < lowest.elevation) lowest = lv;
  }
  return lowest?.id ?? 'lv-1';
}

function discoverDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  const globalDir = join(projectDir, 'global');
  if (existsSync(globalDir)) dirs.push(globalDir);
  for (const entry of readdirSync(projectDir)) {
    const full = join(projectDir, entry);
    if (entry === 'global') continue;
    if (!entry.startsWith('lv') && !/^\d/.test(entry)) continue;
    if (!statSync(full).isDirectory()) continue;
    dirs.push(full);
  }
  return dirs;
}

main();
