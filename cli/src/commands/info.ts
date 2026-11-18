/**
 * `bimdown info` (and the agent's model_info): units, levels, element counts,
 * the type catalog and how many elements use it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistry, getSpecDir } from '../schema/registry.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import { projectUnits } from '../utils/units.js';
import { loadCatalog, typeValues, type ElementType } from '../catalog/index.js';

const TYPES_LISTED = 12;
const num = (v: string | undefined) => (v === undefined ? '' : String(Math.round(Number(v) * 1000) / 1000));

/** The size that tells a type apart: thickness, width×height, section, or the foundation footprint. */
function typeSize(t: ElementType): string {
  const v = typeValues(t);
  if (v.size_x || v.size_y) return [v.designation, `${num(v.size_x)}×${num(v.size_y)}`].filter(Boolean).join(' ');
  if (t.table === 'foundation_type') return [v.kind, [v.width, v.length, v.thickness].filter(Boolean).map(num).join('×')].filter(Boolean).join(' ');
  if (v.width && v.height) return `${num(v.width)}×${num(v.height)}`;
  if (v.thickness) return num(v.thickness);
  return v.family ?? '';
}

export function projectInfoLines(dir: string): string[] {
  const registry = buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);
  const lines: string[] = [];

  const declared = existsSync(join(dir, 'project_metadata.json'));
  lines.push(`Units: ${projectUnits(dir)}${declared ? ' (from project_metadata.json)' : ' (default; no project_metadata.json yet)'}`, '');

  const levelCsv = join(layout.globalDir, 'level.csv');
  if (existsSync(levelCsv)) {
    lines.push('Levels:');
    for (const row of readCsv(levelCsv).rows) lines.push(`  ${row.id}  ${row.name || row.number || ''}  elevation=${row.elevation}`);
    lines.push('');
  }

  const totals: Record<string, number> = {};
  const typed: Record<string, number> = {};
  for (const d of [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs]) {
    if (!existsSync(d.path)) continue;
    const counts: string[] = [];
    for (const f of listFiles(d.path)) {
      if (!f.endsWith('.csv')) continue;
      const table = f.replace('.csv', '');
      const def = registry.get(table);
      if (!def || table.endsWith('_type') || table === 'type_layer') continue;
      const rows = readCsv(join(d.path, f)).rows;
      counts.push(`${table}: ${rows.length}`);
      totals[table] = (totals[table] ?? 0) + rows.length;
      if (def.typeTable) typed[table] = (typed[table] ?? 0) + rows.filter((r) => r.type_id).length;
    }
    if (counts.length > 0) lines.push(`${d.name}/  ${counts.join(', ')}`);
  }

  lines.push('', 'Totals:');
  let grand = 0;
  for (const [table, count] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${table}: ${count}`);
    grand += count;
  }
  lines.push(`  TOTAL: ${grand}`);

  const catalog = loadCatalog(dir);
  const byTable = new Map<string, ElementType[]>();
  for (const t of catalog.types.values()) {
    const list = byTable.get(t.table);
    if (list) list.push(t); else byTable.set(t.table, [t]);
  }
  lines.push('', byTable.size > 0
    ? 'Types (global/*_type.csv; set type_id and leave the type\'s fields empty):'
    : 'Types: none (global/*_type.csv; `bimdown init` writes a starter catalog)');
  for (const [table, list] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
    const shown = list.slice(0, TYPES_LISTED).map((t) => {
      const size = typeSize(t);
      return size ? `${t.id} (${size})` : t.id;
    });
    lines.push(`  ${table}: ${shown.join(', ')}${list.length > TYPES_LISTED ? `, … ${list.length - TYPES_LISTED} more` : ''}`);
  }
  const coverage = Object.entries(typed).filter(([t]) => totals[t] > 0).sort(([a], [b]) => a.localeCompare(b));
  if (coverage.length > 0) lines.push(`  typed: ${coverage.map(([t, n]) => `${t} ${n}/${totals[t]}`).join(', ')}`);
  return lines;
}
