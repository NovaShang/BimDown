/**
 * Computed `volume` (concrete / steel take-off) for structural tables, filled
 * after geometry, height and level ids are hydrated:
 *   structure_column   section area × height
 *   beam / brace       section area × 3D length
 *   structure_wall     length × thickness × height
 *   structure_slab     net area (holes deducted) × thickness
 *   foundation         pad width × length × thickness, round pile π r² × length,
 *                      strip length × width × thickness, raft / cap area × thickness
 * Section areas follow the editor's section families (same default flange / web
 * / leg proportions when those fields are blank). Hosted openings are not deducted.
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { runQuery } from './engine.js';

export const VOLUME_TABLES = new Set([
  'structure_column', 'beam', 'brace', 'structure_wall', 'structure_slab', 'foundation',
]);

/** SQL numeric expression for a column: NULL when absent or blank. */
function col(cols: Set<string>, c: string): string {
  return cols.has(c) ? `TRY_CAST(NULLIF(CAST(t."${c}" AS VARCHAR), '') AS DOUBLE)` : 'CAST(NULL AS DOUBLE)';
}

/** Cross-section area of a structural_section_profile row, in SQL. */
function sectionAreaSql(cols: Set<string>): string {
  const sx = col(cols, 'size_x'), sy = col(cols, 'size_y');
  const fl = col(cols, 'flange'), wb = col(cols, 'web'), th = col(cols, 'thickness');
  const shape = cols.has('shape') ? `COALESCE(NULLIF(CAST(t."shape" AS VARCHAR), ''), 'rect')` : `'rect'`;
  const w = (d: number) => `COALESCE(${sx}, ${d})`;
  const d = (v: number) => `COALESCE(${sy}, ${v})`;
  // I / C: two flanges + web; T: one flange + web; L / cross: two legs (overlap once).
  const twoFlange = (W: string, D: string, f: string, web: string) => `(2 * ${W} * ${f} + (${D} - 2 * ${f}) * ${web})`;
  return `CASE ${shape}
    WHEN 'round' THEN pi() * power(${w(0.3)} / 2, 2)
    WHEN 'i_shape' THEN ${twoFlange(w(0.2), d(0.4), `COALESCE(${fl}, least(${d(0.4)} * 0.15, 0.025))`, `COALESCE(${wb}, least(${w(0.2)} * 0.1, 0.015))`)}
    WHEN 'c_shape' THEN ${twoFlange(w(0.1), d(0.2), `COALESCE(${fl}, least(${d(0.2)} * 0.15, 0.012))`, `COALESCE(${wb}, least(${w(0.1)} * 0.2, 0.008))`)}
    WHEN 't_shape' THEN (${w(0.2)} * COALESCE(${fl}, least(${d(0.3)} * 0.2, 0.03)) + (${d(0.3)} - COALESCE(${fl}, least(${d(0.3)} * 0.2, 0.03))) * COALESCE(${wb}, least(${w(0.2)} * 0.2, 0.02)))
    WHEN 'l_shape' THEN COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.15) * (${w(0.15)} + ${d(0.15)} - COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.15))
    WHEN 'cross' THEN COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.25) * (${w(0.15)} + ${d(0.15)} - COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.25))
    ELSE ${w(0.3)} * ${d(0.3)}
  END`;
}

function volumeSql(table: string, cols: Set<string>): string | null {
  const len = col(cols, 'length'), area = col(cols, 'area'), height = col(cols, 'height');
  const thick = col(cols, 'thickness');
  switch (table) {
    case 'structure_column':
      return `(${sectionAreaSql(cols)}) * ${height}`;
    case 'beam':
    case 'brace':
      // `length` of a spatial line is already its 3D length.
      return `(${sectionAreaSql(cols)}) * ${len}`;
    case 'structure_wall':
      return `${len} * ${thick} * ${height}`;
    case 'structure_slab':
      return `${area} * COALESCE(${thick}, 0.2)`;
    case 'foundation': {
      const width = col(cols, 'width');
      const kind = cols.has('kind') ? `CAST(t."kind" AS VARCHAR)` : `''`;
      const t = `COALESCE(${thick}, 0.4)`;
      // Points have x and no line length (a pad's CSV `length` is its Y size).
      return `CASE
        WHEN ${col(cols, 'area')} IS NOT NULL THEN ${area} * ${t}
        WHEN ${col(cols, 'start_x')} IS NOT NULL THEN ${len} * COALESCE(${width}, 0.8) * ${t}
        WHEN ${kind} = 'pile' AND ${len} IS NULL THEN pi() * power(COALESCE(${width}, 0.6) / 2, 2) * ${t}
        ELSE COALESCE(${width}, 1.5) * COALESCE(${len}, ${width}, 1.5) * ${t}
      END`;
    }
  }
  return null;
}

export async function injectVolume(conn: DuckDBConnection, tableName: string): Promise<void> {
  if (!VOLUME_TABLES.has(tableName)) return;
  const res = await runQuery(conn, `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`);
  const cols = new Set(res.rows.map((r) => String(r.column_name)));
  if (!cols.has('volume')) await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "volume" DOUBLE`);
  const expr = volumeSql(tableName, cols);
  if (!expr) return;
  await runQuery(conn, `UPDATE "${tableName}" AS t SET volume = round(${expr}, 4)`);
}
