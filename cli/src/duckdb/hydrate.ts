import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildRegistry, getSpecDir, GEOJSON_FILE_NAMES, SPATIAL_3D_TABLES } from '../schema/registry.js';
import type { ResolvedTable } from '../schema/types.js';
import { discoverLayout } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import {
  parseGeoJsonFile,
  extractLineGeometry,
  extractPointGeometry,
  extractPolygonGeometry,
  featureId,
  type BimDownFeature,
} from '../utils/geojson.js';
import { runQuery } from './engine.js';

const INSERT_BATCH_SIZE = 500;

export async function hydrate(conn: DuckDBConnection, dir: string): Promise<string[]> {
  const registry = buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);
  const tables: string[] = [];

  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  // Pass 1 — create each table and bulk-insert its CSV rows.
  const hydrated: { name: string; table: ResolvedTable }[] = [];
  for (const [tableName, table] of registry) {
    const csvFiles: { dir: string; fullPath: string }[] = [];
    for (const d of allDirs) {
      const csvPath = join(d.path, `${tableName}.csv`);
      if (existsSync(csvPath)) {
        csvFiles.push({ dir: d.name, fullPath: csvPath });
      }
    }
    if (csvFiles.length === 0) continue;

    const allRows: Record<string, string>[] = [];
    let headers: string[] = [];
    for (const { dir: dirName, fullPath } of csvFiles) {
      const data = readCsv(fullPath);
      if (headers.length === 0) headers = data.headers;
      for (const row of data.rows) {
        allRows.push({ ...row, _partition: dirName });
      }
    }
    if (allRows.length === 0) continue;

    const cols = [...headers, '_partition'];
    const colDefs = cols.map((c) => `"${c}" VARCHAR`).join(', ');
    await runQuery(conn, `CREATE TABLE "${tableName}" (${colDefs})`);

    // Batched multi-row INSERTs instead of one query per row.
    for (let i = 0; i < allRows.length; i += INSERT_BATCH_SIZE) {
      const batch = allRows.slice(i, i + INSERT_BATCH_SIZE);
      const valuesSql = batch
        .map((row) => `(${cols.map((c) => escapeSql(row[c] ?? '')).join(', ')})`)
        .join(', ');
      await runQuery(conn, `INSERT INTO "${tableName}" VALUES ${valuesSql}`);
    }

    tables.push(tableName);
    hydrated.push({ name: tableName, table });
  }

  // Pass 2 — inject geometry-derived fields and GeoJSON properties.
  const levelsReady = await tryCreateLevelsTemp(conn);

  for (const { name, table } of hydrated) {
    await injectGeometry(conn, name, allDirs);

    if (levelsReady && table.computedFields.some((f) => f.name === 'height')) {
      await injectHeight(conn, name);
    }
  }

  return tables;
}

/**
 * Build a temporary `_levels(id, elevation, rank)` table from the already-
 * hydrated `level` table. Returns false if the project has no level.csv.
 */
async function tryCreateLevelsTemp(conn: DuckDBConnection): Promise<boolean> {
  const check = await runQuery(
    conn,
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'level'`,
  );
  if (check.rows.length === 0) return false;

  await runQuery(
    conn,
    `CREATE TEMP TABLE _levels AS
     SELECT
       id,
       CAST(elevation AS DOUBLE) AS elevation,
       ROW_NUMBER() OVER (ORDER BY CAST(elevation AS DOUBLE)) AS rank
     FROM level
     WHERE elevation IS NOT NULL AND elevation <> ''`,
  );
  return true;
}

/**
 * Compute `height` for every row of a vertical_span table in a single SQL
 * UPDATE that joins `_levels` twice (base + top). Cascading defaults:
 *   base_level_id: explicit → _partition (non-global) → lowest level
 *   top_level_id:  explicit → next level above base_level_id
 * Rows that can't resolve either side stay NULL.
 */
async function injectHeight(conn: DuckDBConnection, tableName: string): Promise<void> {
  const colsResult = await runQuery(
    conn,
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`,
  );
  const existing = new Set(colsResult.rows.map((r) => String(r.column_name)));

  const ensureVarchar = async (col: string) => {
    if (!existing.has(col)) {
      await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "${col}" VARCHAR`);
    }
  };
  await ensureVarchar('base_level_id');
  await ensureVarchar('top_level_id');
  await ensureVarchar('base_offset');
  await ensureVarchar('top_offset');
  if (!existing.has('height')) {
    await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "height" DOUBLE`);
  }

  await runQuery(
    conn,
    `UPDATE "${tableName}" AS t
     SET height = (lv_top.elevation + COALESCE(CAST(NULLIF(t.top_offset, '') AS DOUBLE), 0))
                - (lv_base.elevation + COALESCE(CAST(NULLIF(t.base_offset, '') AS DOUBLE), 0))
     FROM _levels AS lv_base, _levels AS lv_top
     WHERE lv_base.id = COALESCE(
             NULLIF(t.base_level_id, ''),
             CASE WHEN t._partition <> 'global'
                  THEN t._partition
                  ELSE (SELECT id FROM _levels ORDER BY rank LIMIT 1)
             END
           )
       AND lv_top.id = COALESCE(
             NULLIF(t.top_level_id, ''),
             (SELECT id FROM _levels WHERE rank = lv_base.rank + 1)
           )`,
  );
}

/**
 * Hydrate geometry-derived fields AND GeoJSON Feature properties into the main
 * DuckDB table. Properties stored in GeoJSON (base_offset, top_offset,
 * height_offset, rotation, arc) appear as table columns alongside CSV columns,
 * so downstream SQL doesn't need to know where each value was physically stored.
 */
async function injectGeometry(
  conn: DuckDBConnection,
  tableName: string,
  dirs: { name: string; path: string }[],
): Promise<void> {
  const fileName = GEOJSON_FILE_NAMES[tableName];
  if (!fileName) return;
  const isSpatial = SPATIAL_3D_TABLES.has(tableName);

  // Map of element id → flat record of computed + property values
  const rowsById = new Map<string, Record<string, number | string>>();

  for (const d of dirs) {
    const path = join(d.path, `${fileName}.geojson`);
    if (!existsSync(path)) continue;

    let fc;
    try {
      fc = parseGeoJsonFile(path);
    } catch {
      continue;
    }

    for (const feature of fc.features) {
      const id = featureId(feature);
      if (!id || id === '<unknown>') continue;
      const out: Record<string, number | string> = {};
      extractGeometryFields(feature, isSpatial, out);
      extractPropertyFields(feature, out);
      rowsById.set(id, out);
    }
  }

  if (rowsById.size === 0) return;

  // Union of all field names across collected rows.
  const allKeys = new Set<string>();
  for (const rec of rowsById.values()) {
    for (const k of Object.keys(rec)) allKeys.add(k);
  }
  const cols = Array.from(allKeys);
  // `points`/`shape` are strings. base_offset/top_offset/height_offset are stored as VARCHAR
  // so injectHeight's NULLIF-CAST pattern keeps working uniformly across CSV-derived and
  // GeoJSON-derived columns. Everything else is DOUBLE.
  const stringCols = new Set(['points', 'shape', 'base_offset', 'top_offset', 'height_offset']);
  const typeOf = (col: string) => (stringCols.has(col) ? 'VARCHAR' : 'DOUBLE');

  // Add any missing columns on the main table.
  const existingCols = await runQuery(
    conn,
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`,
  );
  const existingSet = new Set(existingCols.rows.map((r) => String(r.column_name)));
  for (const col of cols) {
    if (existingSet.has(col)) continue;
    await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "${col}" ${typeOf(col)}`);
  }

  // Stage into a temp table, then UPDATE ... FROM.
  const stagingName = `_geo_${tableName}`;
  const stagingColDefs = ['"id" VARCHAR', ...cols.map((c) => `"${c}" ${typeOf(c)}`)].join(', ');
  await runQuery(conn, `CREATE TEMP TABLE "${stagingName}" (${stagingColDefs})`);

  const entries = Array.from(rowsById.entries());
  for (let i = 0; i < entries.length; i += INSERT_BATCH_SIZE) {
    const batch = entries.slice(i, i + INSERT_BATCH_SIZE);
    const valuesSql = batch
      .map(([id, rec]) => {
        const vals = [escapeSql(id)];
        for (const col of cols) {
          const v = rec[col];
          if (v === undefined || v === null) {
            vals.push('NULL');
          } else if (typeof v === 'string') {
            vals.push(escapeSql(v));
          } else if (stringCols.has(col)) {
            // Numeric value going into a VARCHAR column — quote it.
            vals.push(escapeSql(String(v)));
          } else {
            vals.push(String(v));
          }
        }
        return `(${vals.join(', ')})`;
      })
      .join(', ');
    await runQuery(conn, `INSERT INTO "${stagingName}" VALUES ${valuesSql}`);
  }

  const setClause = cols.map((c) => `"${c}" = g."${c}"`).join(', ');
  await runQuery(
    conn,
    `UPDATE "${tableName}" SET ${setClause} FROM "${stagingName}" g WHERE "${tableName}".id = g.id`,
  );

  await runQuery(conn, `DROP TABLE "${stagingName}"`);
}

function extractGeometryFields(feature: BimDownFeature, isSpatial: boolean, out: Record<string, number | string>): void {
  const g = feature.geometry;
  if (g.type === 'LineString') {
    const lg = extractLineGeometry(feature);
    out.start_x = lg.start_x;
    out.start_y = lg.start_y;
    out.end_x = lg.end_x;
    out.end_y = lg.end_y;
    out.length = lg.length;
    if (isSpatial) {
      if (lg.start_z !== undefined) out.start_z = lg.start_z;
      if (lg.end_z !== undefined) out.end_z = lg.end_z;
    }
  } else if (g.type === 'Point') {
    const pg = extractPointGeometry(feature);
    out.x = pg.x;
    out.y = pg.y;
    out.rotation = pg.rotation;
    if (isSpatial && pg.z !== undefined) out.z = pg.z;
  } else if (g.type === 'Polygon') {
    const pg = extractPolygonGeometry(feature);
    out.points = pg.outer.map((p) => `${p.x},${p.y}`).join(' ');
    out.area = pg.area;
  }
}

function extractPropertyFields(feature: BimDownFeature, out: Record<string, number | string>): void {
  const p = feature.properties;
  if (typeof p.base_offset === 'number') out.base_offset = p.base_offset;
  if (typeof p.top_offset === 'number') out.top_offset = p.top_offset;
  if (typeof p.height_offset === 'number') out.height_offset = p.height_offset;
  // rotation may also come from properties (already covered for Points; for non-Points it's still meaningful)
  if (typeof p.rotation === 'number' && out.rotation === undefined) out.rotation = p.rotation;
}

function escapeSql(val: string): string {
  return "'" + val.replace(/'/g, "''") + "'";
}
