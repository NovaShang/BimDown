import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { buildRegistry, getSpecDir } from '../schema/registry.js';
import { writeCsv, type CsvData } from '../utils/csv.js';
import { runQuery } from './engine.js';

export async function dehydrate(conn: DuckDBConnection, dir: string): Promise<void> {
  const registry = buildRegistry(getSpecDir());

  for (const [tableName, table] of registry) {
    // Check if table exists
    const check = await runQuery(
      conn,
      `SELECT count(*) as cnt FROM information_schema.tables WHERE table_name = '${tableName}'`,
    );
    if (!check.rows.length || check.rows[0].cnt === 0n) continue;

    // Only select CSV fields that actually exist as columns in DuckDB
    // (mixin fields like host_x/host_y are valid AI inputs but absent in dehydrated data).
    const colsResult = await runQuery(
      conn,
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`,
    );
    const existingCols = new Set(colsResult.rows.map((r) => String(r.column_name)));
    const csvHeaders = table.csvFields.map((f) => f.name).filter((h) => existingCols.has(h));
    if (csvHeaders.length === 0) continue;

    const partResult = await runQuery(
      conn,
      `SELECT DISTINCT _partition FROM "${tableName}"`,
    );

    for (const partRow of partResult.rows) {
      const partition = String(partRow._partition);
      const outDir = join(dir, partition);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const selectCols = csvHeaders.map((h) => `"${h}"`).join(', ');
      const dataResult = await runQuery(
        conn,
        `SELECT ${selectCols} FROM "${tableName}" WHERE _partition = '${partition}'`,
      );

      const data: CsvData = {
        headers: csvHeaders,
        rows: dataResult.rows.map((r) => {
          const row: Record<string, string> = {};
          for (const h of csvHeaders) {
            const val = r[h];
            row[h] = val == null ? '' : String(val);
          }
          return row;
        }),
      };

      writeCsv(join(outDir, `${tableName}.csv`), data);
    }
  }
}
