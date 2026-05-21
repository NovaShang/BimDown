import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readCsv, writeCsv, type CsvData } from '../utils/csv.js';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  type BimDownFeature,
  type BimDownFeatureCollection,
} from '../utils/geojson.js';
import { discoverLayout, listFiles, type ProjectLayout } from '../utils/fs.js';
import {
  buildRegistry,
  getSpecDir,
  GEOJSON_FILE_NAMES,
} from '../schema/registry.js';
import type { ResolvedTable } from '../schema/types.js';

interface MergeGeomInput {
  features: BimDownFeature[];
  idRemap: Map<string, string>;
}

function writeMergedGeoJson(inputs: MergeGeomInput[]): string {
  const features: BimDownFeature[] = [];
  for (const input of inputs) {
    for (const f of input.features) {
      const oldId = String(f.properties?.id ?? '');
      const newId = input.idRemap.get(oldId) ?? oldId;
      features.push({
        ...f,
        properties: { ...f.properties, id: newId },
      });
    }
  }
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  return stringifyFeatureCollection(fc);
}

const ELEVATION_TOLERANCE = 0.001;
const GRID_COORD_TOLERANCE = 0.01;

// Fields that contain IDs and need remapping (schema reference fields + known ID string fields)
const KNOWN_ID_FIELDS = new Set([
  'id', 'host_id', 'top_level_id', 'level_id',
  'start_node_id', 'end_node_id',
]);

interface SourceData {
  name: string;
  layout: ProjectLayout;
  levels: CsvData;
  grids: CsvData | null;
  idMap: CsvData | null;
  /** levelDirName -> tableName -> { csv, geomFile? } */
  levelData: Map<string, Map<string, { csv: CsvData; geomFile: string | null }>>;
  /** global table data (beam, stair, etc. that live in global/) */
  globalData: Map<string, { csv: CsvData; geomFile: string | null }>;
}

export async function merge(dirs: string[], outputDir: string): Promise<void> {
  const registry = buildRegistry(getSpecDir());

  // ─── Phase 1: Scan ──────────────────────────────────────
  console.log(`Scanning ${dirs.length} sources...`);
  const sources = dirs.map((dir) => scanSource(dir, registry));

  // ─── Phase 2: Deduplicate levels ────────────────────────
  const { canonicalLevels, levelRemaps } = deduplicateLevels(sources);
  console.log(`Merged levels: ${canonicalLevels.rows.length} unique levels`);

  // ─── Phase 3: Deduplicate grids ─────────────────────────
  const { canonicalGrids, gridRemaps } = deduplicateGrids(sources);
  console.log(`Merged grids: ${canonicalGrids.rows.length} unique grids`);

  // ─── Phase 4: Remap element IDs ─────────────────────────
  const fullRemaps = buildFullRemaps(sources, levelRemaps, gridRemaps, registry);

  // ─── Phase 5: Write output ──────────────────────────────
  mkdirSync(join(outputDir, 'global'), { recursive: true });

  // Write levels
  writeCsv(join(outputDir, 'global', 'level.csv'), canonicalLevels);

  // Write grids
  if (canonicalGrids.rows.length > 0) {
    writeCsv(join(outputDir, 'global', 'grid.csv'), canonicalGrids);
  }

  // Write merged _IdMap
  writeIdMap(outputDir, sources, fullRemaps);

  // Build level-dir name mapping: canonical level id -> output dir name
  const levelDirMap = buildLevelDirMap(sources, fullRemaps);

  // Write global-only element tables (beam, stair, etc.)
  writeGlobalTables(outputDir, sources, fullRemaps, registry);

  // Write per-level CSVs and SVGs
  writeLevelTables(outputDir, sources, fullRemaps, levelDirMap, registry);

  console.log(`Merge complete → ${outputDir}`);
}

// ─── Phase 1: Scan ──────────────────────────────────────

function scanSource(dir: string, registry: Map<string, ResolvedTable>): SourceData {
  const layout = discoverLayout(dir);
  const name = basename(dir);

  // Read levels
  const levelPath = join(layout.globalDir, 'level.csv');
  if (!existsSync(levelPath)) {
    throw new Error(`Missing level.csv in ${dir}/global/`);
  }
  const levels = readCsv(levelPath);

  // Read grids (optional)
  const gridPath = join(layout.globalDir, 'grid.csv');
  const grids = existsSync(gridPath) ? readCsv(gridPath) : null;

  // Read _IdMap (optional)
  const idMapPath = join(layout.globalDir, '_IdMap.csv');
  const idMap = existsSync(idMapPath) ? readCsv(idMapPath) : null;

  // Read global element tables (non-level, non-grid, non-_IdMap)
  const globalData = new Map<string, { csv: CsvData; geomFile: string | null }>();
  if (existsSync(layout.globalDir)) {
    for (const f of listFiles(layout.globalDir)) {
      if (!f.endsWith('.csv')) continue;
      const tableName = f.replace('.csv', '');
      if (tableName === 'level' || tableName === 'grid' || tableName === '_IdMap') continue;
      if (!registry.has(tableName)) continue;
      const csv = readCsv(join(layout.globalDir, f));
      const geomName = GEOJSON_FILE_NAMES[tableName];
      const geomFile = geomName ? join(layout.globalDir, geomName + '.geojson') : null;
      globalData.set(tableName, { csv, geomFile: geomFile && existsSync(geomFile) ? geomFile : null });
    }
  }

  // Read per-level data
  const levelData = new Map<string, Map<string, { csv: CsvData; geomFile: string | null }>>();
  for (const ld of layout.levelDirs) {
    const tables = new Map<string, { csv: CsvData; geomFile: string | null }>();
    for (const f of listFiles(ld.path)) {
      if (!f.endsWith('.csv')) continue;
      const tableName = f.replace('.csv', '');
      if (!registry.has(tableName)) continue;
      const csv = readCsv(join(ld.path, f));
      const geomName = GEOJSON_FILE_NAMES[tableName];
      const geomFile = geomName ? join(ld.path, geomName + '.geojson') : null;
      tables.set(tableName, { csv, geomFile: geomFile && existsSync(geomFile) ? geomFile : null });
    }
    if (tables.size > 0) {
      levelData.set(ld.name, tables);
    }
  }

  return { name, layout, levels, grids, idMap, levelData, globalData };
}

// ─── Phase 2: Deduplicate levels ────────────────────────

interface LevelEntry {
  sourceIdx: number;
  id: string;
  name: string;
  number: string;
  elevation: number;
}

function deduplicateLevels(sources: SourceData[]): {
  canonicalLevels: CsvData;
  levelRemaps: Map<string, string>[]; // per-source: oldId -> newId
} {
  // Collect all levels
  const allLevels: LevelEntry[] = [];
  for (let si = 0; si < sources.length; si++) {
    for (const row of sources[si].levels.rows) {
      allLevels.push({
        sourceIdx: si,
        id: row.id,
        name: row.name ?? '',
        number: row.number ?? '',
        elevation: parseFloat(row.elevation ?? '0'),
      });
    }
  }

  // Sort by elevation
  allLevels.sort((a, b) => a.elevation - b.elevation);

  // Group by elevation (within tolerance)
  const groups: LevelEntry[][] = [];
  for (const lv of allLevels) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].elevation - lv.elevation) <= ELEVATION_TOLERANCE) {
      last.push(lv);
    } else {
      groups.push([lv]);
    }
  }

  // Assign canonical IDs
  const canonicalRows: Record<string, string>[] = [];
  const remaps: Map<string, string>[] = sources.map(() => new Map());

  for (let gi = 0; gi < groups.length; gi++) {
    const canonId = `lv-${gi + 1}`;
    const rep = groups[gi][0]; // use first entry's metadata
    canonicalRows.push({
      id: canonId,
      number: rep.number,
      name: rep.name,
      elevation: String(rep.elevation),
    });
    for (const entry of groups[gi]) {
      remaps[entry.sourceIdx].set(entry.id, canonId);
    }
  }

  return {
    canonicalLevels: { headers: ['id', 'number', 'name', 'elevation'], rows: canonicalRows },
    levelRemaps: remaps,
  };
}

// ─── Phase 3: Deduplicate grids ─────────────────────────

interface GridEntry {
  sourceIdx: number;
  id: string;
  number: string;
  start_x: number; start_y: number;
  end_x: number; end_y: number;
}

function deduplicateGrids(sources: SourceData[]): {
  canonicalGrids: CsvData;
  gridRemaps: Map<string, string>[];
} {
  const allGrids: GridEntry[] = [];
  for (let si = 0; si < sources.length; si++) {
    if (!sources[si].grids) continue;
    for (const row of sources[si].grids!.rows) {
      allGrids.push({
        sourceIdx: si,
        id: row.id,
        number: row.number ?? '',
        start_x: parseFloat(row.start_x ?? '0'),
        start_y: parseFloat(row.start_y ?? '0'),
        end_x: parseFloat(row.end_x ?? '0'),
        end_y: parseFloat(row.end_y ?? '0'),
      });
    }
  }

  const remaps: Map<string, string>[] = sources.map(() => new Map());
  if (allGrids.length === 0) {
    return { canonicalGrids: { headers: ['id', 'number', 'start_x', 'start_y', 'end_x', 'end_y'], rows: [] }, gridRemaps: remaps };
  }

  // Match grids by coordinates
  const matched: GridEntry[][] = [];

  for (const g of allGrids) {
    let found = false;
    for (const group of matched) {
      const rep = group[0];
      if (
        Math.abs(rep.start_x - g.start_x) <= GRID_COORD_TOLERANCE &&
        Math.abs(rep.start_y - g.start_y) <= GRID_COORD_TOLERANCE &&
        Math.abs(rep.end_x - g.end_x) <= GRID_COORD_TOLERANCE &&
        Math.abs(rep.end_y - g.end_y) <= GRID_COORD_TOLERANCE
      ) {
        group.push(g);
        found = true;
        break;
      }
    }
    if (!found) {
      matched.push([g]);
    }
  }

  const canonicalRows: Record<string, string>[] = [];
  for (let gi = 0; gi < matched.length; gi++) {
    const canonId = `gr-${gi + 1}`;
    const rep = matched[gi][0];
    canonicalRows.push({
      id: canonId,
      number: rep.number,
      start_x: String(rep.start_x),
      start_y: String(rep.start_y),
      end_x: String(rep.end_x),
      end_y: String(rep.end_y),
    });
    for (const entry of matched[gi]) {
      remaps[entry.sourceIdx].set(entry.id, canonId);
    }
  }

  return {
    canonicalGrids: { headers: ['id', 'number', 'start_x', 'start_y', 'end_x', 'end_y'], rows: canonicalRows },
    gridRemaps: remaps,
  };
}

// ─── Phase 4: Remap element IDs ─────────────────────────

function buildFullRemaps(
  sources: SourceData[],
  levelRemaps: Map<string, string>[],
  gridRemaps: Map<string, string>[],
  registry: Map<string, ResolvedTable>,
): Map<string, string>[] {
  const remaps: Map<string, string>[] = sources.map((_, i) => {
    const m = new Map<string, string>();
    // Start with level and grid remaps
    for (const [old, nw] of levelRemaps[i]) m.set(old, nw);
    for (const [old, nw] of gridRemaps[i]) m.set(old, nw);
    return m;
  });

  // Collect all element IDs per prefix across sources, then renumber
  const prefixCounters = new Map<string, number>();

  // First pass: collect all IDs grouped by prefix
  const prefixGroups = new Map<string, { sourceIdx: number; oldId: string }[]>();

  for (let si = 0; si < sources.length; si++) {
    const collectIds = (csv: CsvData) => {
      for (const row of csv.rows) {
        if (!row.id) continue;
        const dash = row.id.indexOf('-');
        if (dash < 0) continue;
        const prefix = row.id.substring(0, dash);
        // Skip levels and grids (already handled)
        if (prefix === 'lv' || prefix === 'gr') continue;
        let group = prefixGroups.get(prefix);
        if (!group) { group = []; prefixGroups.set(prefix, group); }
        group.push({ sourceIdx: si, oldId: row.id });
      }
    };

    // Global tables
    for (const [, data] of sources[si].globalData) {
      collectIds(data.csv);
    }

    // Level tables
    for (const [, tables] of sources[si].levelData) {
      for (const [, data] of tables) {
        collectIds(data.csv);
      }
    }
  }

  // Second pass: assign new sequential IDs per prefix
  for (const [prefix, group] of prefixGroups) {
    let counter = 1;
    for (const { sourceIdx, oldId } of group) {
      const newId = `${prefix}-${counter}`;
      remaps[sourceIdx].set(oldId, newId);
      counter++;
    }
  }

  return remaps;
}

function remapRow(row: Record<string, string>, remap: Map<string, string>, refFieldNames: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(row)) {
    if (val && (refFieldNames.has(key) || KNOWN_ID_FIELDS.has(key))) {
      out[key] = remap.get(val) ?? val;
    } else {
      out[key] = val;
    }
  }
  return out;
}

function getRefFieldNames(registry: Map<string, ResolvedTable>): Set<string> {
  const names = new Set<string>();
  for (const [, table] of registry) {
    for (const f of table.csvFields) {
      if (f.type === 'reference') names.add(f.name);
    }
  }
  // Also include known ID fields
  for (const f of KNOWN_ID_FIELDS) names.add(f);
  return names;
}

// ─── Phase 5: Write output ──────────────────────────────

function writeIdMap(
  outputDir: string,
  sources: SourceData[],
  remaps: Map<string, string>[],
): void {
  const seenUuid = new Map<string, string>(); // uuid -> remapped id
  const rows: Record<string, string>[] = [];

  for (let si = 0; si < sources.length; si++) {
    if (!sources[si].idMap) continue;
    for (const row of sources[si].idMap!.rows) {
      const oldId = row.id;
      const uuid = row.uuid;
      const newId = remaps[si].get(oldId) ?? oldId;

      // Dedup by uuid
      if (seenUuid.has(uuid)) continue;
      seenUuid.set(uuid, newId);
      rows.push({ id: newId, uuid });
    }
  }

  if (rows.length > 0) {
    writeCsv(join(outputDir, 'global', '_IdMap.csv'), { headers: ['id', 'uuid'], rows });
  }
}

function buildLevelDirMap(
  sources: SourceData[],
  remaps: Map<string, string>[],
): Map<string, Map<string, string>> {
  // sourceIdx -> sourceLevelDirName -> outputLevelDirName
  const result = new Map<string, Map<string, string>>();

  for (let si = 0; si < sources.length; si++) {
    const dirMap = new Map<string, string>();
    const src = sources[si];

    // Build level id -> level dir name mapping for this source
    // Level dirs are named lv-N, and each level row has id lv-N
    // The level's data lives in the dir matching its id
    for (const ld of src.layout.levelDirs) {
      // Find which level id this dir corresponds to
      // The dir name IS the level id (e.g., lv-2)
      const oldLevelId = ld.name;
      const newLevelId = remaps[si].get(oldLevelId);
      if (newLevelId) {
        dirMap.set(ld.name, newLevelId);
      } else {
        dirMap.set(ld.name, ld.name); // no remap needed
      }
    }

    result.set(String(si), dirMap);
  }

  return result;
}

function writeGlobalTables(
  outputDir: string,
  sources: SourceData[],
  remaps: Map<string, string>[],
  registry: Map<string, ResolvedTable>,
): void {
  const refFields = getRefFieldNames(registry);

  // Collect global tables across sources
  const merged = new Map<string, { rows: Record<string, string>[]; headers: string[]; geomInputs: MergeGeomInput[] }>();

  for (let si = 0; si < sources.length; si++) {
    for (const [tableName, data] of sources[si].globalData) {
      if (!merged.has(tableName)) {
        merged.set(tableName, { rows: [], headers: data.csv.headers, geomInputs: [] });
      }
      const entry = merged.get(tableName)!;

      for (const row of data.csv.rows) {
        entry.rows.push(remapRow(row, remaps[si], refFields));
      }

      if (data.geomFile) {
        try {
          const fc = parseGeoJsonFile(data.geomFile);
          entry.geomInputs.push({ features: fc.features, idRemap: remaps[si] });
        } catch { /* ignore unparseable geometry */ }
      }
    }
  }

  for (const [tableName, entry] of merged) {
    if (entry.rows.length > 0) {
      writeCsv(join(outputDir, 'global', tableName + '.csv'), { headers: entry.headers, rows: entry.rows });
    }
    if (entry.geomInputs.length > 0) {
      const geomName = GEOJSON_FILE_NAMES[tableName];
      if (geomName) {
        const content = writeMergedGeoJson(entry.geomInputs);
        writeFileSync(join(outputDir, 'global', geomName + '.geojson'), content, 'utf-8');
      }
    }
  }
}

function writeLevelTables(
  outputDir: string,
  sources: SourceData[],
  remaps: Map<string, string>[],
  levelDirMap: Map<string, Map<string, string>>,
  registry: Map<string, ResolvedTable>,
): void {
  const refFields = getRefFieldNames(registry);

  // outputLevelDir -> tableName -> { rows, headers, geomInputs }
  const merged = new Map<string, Map<string, { rows: Record<string, string>[]; headers: string[]; geomInputs: MergeGeomInput[] }>>();

  for (let si = 0; si < sources.length; si++) {
    const dirMap = levelDirMap.get(String(si))!;

    for (const [srcDirName, tables] of sources[si].levelData) {
      const outDirName = dirMap.get(srcDirName) ?? srcDirName;

      if (!merged.has(outDirName)) {
        merged.set(outDirName, new Map());
      }
      const levelMerged = merged.get(outDirName)!;

      for (const [tableName, data] of tables) {
        if (!levelMerged.has(tableName)) {
          levelMerged.set(tableName, { rows: [], headers: data.csv.headers, geomInputs: [] });
        }
        const entry = levelMerged.get(tableName)!;

        for (const row of data.csv.rows) {
          entry.rows.push(remapRow(row, remaps[si], refFields));
        }

        if (data.geomFile) {
          try {
            const fc = parseGeoJsonFile(data.geomFile);
            entry.geomInputs.push({ features: fc.features, idRemap: remaps[si] });
          } catch { /* ignore */ }
        }
      }
    }
  }

  // Write all level dirs
  for (const [outDirName, tables] of merged) {
    const dirPath = join(outputDir, outDirName);
    mkdirSync(dirPath, { recursive: true });

    for (const [tableName, entry] of tables) {
      if (entry.rows.length > 0) {
        writeCsv(join(dirPath, tableName + '.csv'), { headers: entry.headers, rows: entry.rows });
      }
      if (entry.geomInputs.length > 0) {
        const geomName = GEOJSON_FILE_NAMES[tableName];
        if (geomName) {
          const content = writeMergedGeoJson(entry.geomInputs);
          writeFileSync(join(dirPath, geomName + '.geojson'), content, 'utf-8');
        }
      }
    }
  }
}
