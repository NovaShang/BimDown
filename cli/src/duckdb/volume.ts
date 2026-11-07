/**
 * Computed `volume` (concrete / steel take-off) for structural tables, filled
 * after geometry, height and level ids are hydrated:
 *   structure_column   section area × height
 *   beam / brace       section area × 3D length
 *   structure_wall     length × thickness × height
 *   structure_slab     net area × thickness (`net_area`: outline − inner rings
 *                      − the slab openings hosted on it)
 *   foundation         pad width × length × thickness, round pile π r² × length,
 *                      strip length × width × thickness, raft / cap area × thickness
 * plus `weight` (kg) = volume × material density for columns and framing.
 * Section areas follow the editor's section families (same default flange / web
 * / leg proportions when those fields are blank; root fillets and rounded
 * hollow-section corners included). Wall openings are not deducted.
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { runQuery } from './engine.js';

export const VOLUME_TABLES = new Set([
  'structure_column', 'beam', 'brace', 'structure_wall', 'structure_slab', 'foundation',
]);

/** Tables that also get `weight` (kg). */
export const WEIGHT_TABLES = new Set(['structure_column', 'beam', 'brace']);

/** Density per `material`, kg/m³ (reinforced concrete 2500). */
export const MATERIAL_DENSITY: Record<string, number> = {
  steel: 7850, concrete: 2500, wood: 500, clt: 470, aluminum: 2700, glass: 2500,
  brick: 1800, stone: 2600, composite: 1600,
};

/** Model units per metre for a project unit (volumes scale by its cube). */
export function unitsPerMetre(unit: string | undefined): number {
  return unit === 'mm' ? 1000 : unit === 'ft' ? 1 / 0.3048 : unit === 'in' ? 1 / 0.0254 : 1;
}

/** SQL numeric expression for a column: NULL when absent or blank. */
function col(cols: Set<string>, c: string): string {
  return cols.has(c) ? `TRY_CAST(NULLIF(CAST(t."${c}" AS VARCHAR), '') AS DOUBLE)` : 'CAST(NULL AS DOUBLE)';
}

/** Cross-section area of a structural_section_profile row, in SQL. */
function sectionAreaSql(cols: Set<string>): string {
  const sx = col(cols, 'size_x'), sy = col(cols, 'size_y');
  const fl = col(cols, 'flange'), wb = col(cols, 'web'), th = col(cols, 'thickness');
  const r = `COALESCE(${col(cols, 'root_radius')}, 0)`;
  const shape = cols.has('shape') ? `COALESCE(NULLIF(CAST(t."shape" AS VARCHAR), ''), 'rect')` : `'rect'`;
  const w = (d: number) => `COALESCE(${sx}, ${d})`;
  const d = (v: number) => `COALESCE(${sy}, ${v})`;
  // One root fillet adds (1 − π/4) r².
  const fillets = (n: number) => `${n} * (1 - pi() / 4) * power(${r}, 2)`;
  // I / C: two flanges + web; T: one flange + web; L / cross: two legs (overlap once).
  const twoFlange = (W: string, D: string, f: string, web: string) => `(2 * ${W} * ${f} + (${D} - 2 * ${f}) * ${web})`;
  const rhT = `COALESCE(${th}, least(${w(0.2)}, ${d(0.2)}) * 0.05)`;
  const rhRo = `least(${r}, least(${w(0.2)}, ${d(0.2)}) / 2)`;
  const rhRi = `greatest(${rhRo} - ${rhT}, 0)`;
  const chsT = `COALESCE(${th}, ${w(0.2)} * 0.04)`;
  return `CASE ${shape}
    WHEN 'round' THEN pi() * power(${w(0.3)} / 2, 2)
    WHEN 'i_shape' THEN ${twoFlange(w(0.2), d(0.4), `COALESCE(${fl}, least(${d(0.4)} * 0.15, 0.025))`, `COALESCE(${wb}, least(${w(0.2)} * 0.1, 0.015))`)} + ${fillets(4)}
    WHEN 'c_shape' THEN ${twoFlange(w(0.1), d(0.2), `COALESCE(${fl}, least(${d(0.2)} * 0.15, 0.012))`, `COALESCE(${wb}, least(${w(0.1)} * 0.2, 0.008))`)} + ${fillets(2)}
    WHEN 't_shape' THEN (${w(0.2)} * COALESCE(${fl}, least(${d(0.3)} * 0.2, 0.03)) + (${d(0.3)} - COALESCE(${fl}, least(${d(0.3)} * 0.2, 0.03))) * COALESCE(${wb}, least(${w(0.2)} * 0.2, 0.02))) + ${fillets(2)}
    WHEN 'l_shape' THEN COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.15) * (${w(0.15)} + ${d(0.15)} - COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.15)) + ${fillets(1)}
    WHEN 'cross' THEN COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.25) * (${w(0.15)} + ${d(0.15)} - COALESCE(${th}, least(${w(0.15)}, ${d(0.15)}) * 0.25))
    WHEN 'rect_hollow' THEN ${w(0.2)} * ${d(0.2)} - greatest(${w(0.2)} - 2 * ${rhT}, 0) * greatest(${d(0.2)} - 2 * ${rhT}, 0)
      - (4 - pi()) * (power(${rhRo}, 2) - power(${rhRi}, 2))
    WHEN 'round_hollow' THEN pi() / 4 * (power(${w(0.2)}, 2) - power(greatest(${w(0.2)} - 2 * ${chsT}, 0), 2))
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
      return `COALESCE(${col(cols, 'net_area')}, ${area}) * COALESCE(${thick}, 0.2)`;
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

async function columnsOf(conn: DuckDBConnection, tableName: string): Promise<Set<string>> {
  const res = await runQuery(conn, `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`);
  return new Set(res.rows.map((r) => String(r.column_name)));
}

/**
 * `net_area` of slabs: polygon area (inner rings already deducted) minus the
 * areas of the Polygon openings hosted on them. Runs once every table has its
 * geometry, before the slab volume.
 */
export async function injectSlabNetArea(conn: DuckDBConnection, slabTable: string, hasOpenings: boolean): Promise<void> {
  const cols = await columnsOf(conn, slabTable);
  if (!cols.has('area')) return;
  if (!cols.has('net_area')) await runQuery(conn, `ALTER TABLE "${slabTable}" ADD COLUMN "net_area" DOUBLE`);
  const area = `TRY_CAST(NULLIF(CAST(t."area" AS VARCHAR), '') AS DOUBLE)`;
  await runQuery(conn, `UPDATE "${slabTable}" AS t SET net_area = round(${area}, 4)`);
  if (!hasOpenings) return;
  const oc = await columnsOf(conn, 'opening');
  if (!oc.has('host_id') || !oc.has('area')) return;
  await runQuery(conn, `UPDATE "${slabTable}" AS t SET net_area = round(greatest(${area} - o.cut, 0), 4)
    FROM (SELECT CAST(host_id AS VARCHAR) AS hid, CAST(_partition AS VARCHAR) AS part,
                 SUM(TRY_CAST(NULLIF(CAST(area AS VARCHAR), '') AS DOUBLE)) AS cut
          FROM opening WHERE host_id IS NOT NULL AND CAST(host_id AS VARCHAR) <> '' GROUP BY 1, 2) AS o
    WHERE o.hid = CAST(t.id AS VARCHAR) AND o.part = CAST(t._partition AS VARCHAR) AND o.cut > 0`);
}

export async function injectVolume(conn: DuckDBConnection, tableName: string, unit?: string): Promise<void> {
  if (!VOLUME_TABLES.has(tableName)) return;
  const cols = await columnsOf(conn, tableName);
  if (!cols.has('volume')) await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "volume" DOUBLE`);
  const expr = volumeSql(tableName, cols);
  if (!expr) return;
  await runQuery(conn, `UPDATE "${tableName}" AS t SET volume = round(${expr}, 4)`);
  if (!WEIGHT_TABLES.has(tableName)) return;
  if (!cols.has('weight')) await runQuery(conn, `ALTER TABLE "${tableName}" ADD COLUMN "weight" DOUBLE`);
  const upm = unitsPerMetre(unit);
  const mat = cols.has('material') ? `CAST(t."material" AS VARCHAR)` : `''`;
  const density = `CASE ${mat} ${Object.entries(MATERIAL_DENSITY).map(([m, d]) => `WHEN '${m}' THEN ${d}`).join(' ')} ELSE NULL END`;
  // Volume (unrounded) is in model units³: kg = volume / upm³ × density.
  await runQuery(conn, `UPDATE "${tableName}" AS t SET weight = round((${expr}) / ${upm ** 3} * ${density}, 2)`);
}
