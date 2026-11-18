/**
 * Authoring hints for `bimdown build` (not warnings: the model is valid):
 * elements written with raw sizes instead of a type (Revit always places a
 * type), and doors / windows without a mark. One line per table, project-wide.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from '../utils/csv.js';
import { discoverLayout } from '../utils/fs.js';
import { buildRegistry, getSpecDir } from '../schema/registry.js';
import { loadCatalog, sameValue, typeParamFields, typeValues, type ElementType } from '../catalog/index.js';

/** Size fields that identify a type (a row setting none of them is not "raw"). */
const SIZE_FIELDS = ['thickness', 'width', 'length', 'height', 'size_x', 'size_y'];
/** Typed tables placed by family / host rather than by size. */
const SKIP = new Set(['furniture', 'railing']);
const MARKED = ['door', 'window'];
const LIST = 3;

interface Raw { at: string; id: string; row: Record<string, string> }

function rowsOf(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  try { return readCsv(path).rows; } catch { return []; }
}

/** The type whose parameters agree with every one the row sets (at least one size), if any. */
function matchingType(row: Record<string, string>, fields: string[], types: ElementType[]): ElementType | undefined {
  return types.find((t) => {
    const v = typeValues(t);
    let sized = false;
    for (const f of fields) {
      const own = (row[f] ?? '').trim();
      if (!own) continue;
      if (v[f] === undefined) return false;
      if (!sameValue(own, v[f])) return false;
      if (SIZE_FIELDS.includes(f)) sized = true;
    }
    return sized;
  });
}

/** A size as written, trimmed to 4 decimals for display. */
const short = (v: string) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 1e4) / 1e4) : v);
const ids = (list: Raw[]) => list.slice(0, LIST).map((r) => r.at).join(', ') + (list.length > LIST ? ', …' : '');

export function authoringHints(dir: string): string[] {
  const registry = buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);
  const dirs = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs];
  const catalog = loadCatalog(dir);
  const out: string[] = [];

  for (const [table, def] of [...registry].sort(([a], [b]) => a.localeCompare(b))) {
    if (!def.typeTable || SKIP.has(table)) continue;
    const fields = typeParamFields(table);
    const sizeFields = fields.filter((f) => SIZE_FIELDS.includes(f));
    if (sizeFields.length === 0) continue;
    const raw: Raw[] = [];
    for (const d of dirs) {
      for (const row of rowsOf(join(d.path, `${table}.csv`))) {
        if (row.type_id || !sizeFields.some((f) => (row[f] ?? '').trim())) continue;
        raw.push({ at: `${d.name}/${row.id}`, id: row.id, row });
      }
    }
    if (raw.length === 0) continue;

    const types = [...catalog.types.values()].filter((t) => t.table === def.typeTable);
    const byType = new Map<string, Raw[]>();
    const unmatched: Raw[] = [];
    for (const r of raw) {
      const t = matchingType(r.row, fields, types);
      if (!t) { unmatched.push(r); continue; }
      const list = byType.get(t.id);
      if (list) list.push(r); else byType.set(t.id, [r]);
    }
    const parts: string[] = [];
    if (byType.size > 0) {
      const matched = [...byType].map(([id, list]) => `${id} ← ${list.length} (${ids(list)})`).join('; ');
      const set = fields.filter((f) => [...byType.values()].some((l) => l.some((r) => (r.row[f] ?? '').trim())));
      parts.push(`same size as a ${def.typeTable}: ${matched} — set type_id, clear ${set.join('/')} (check the material)`);
    }
    if (unmatched.length > 0) {
      const shown = sizeFields.filter((f) => unmatched.some((r) => (r.row[f] ?? '').trim()));
      const sizes = new Map<string, number>();
      for (const r of unmatched) {
        const k = shown.map((f) => (r.row[f] ? short(r.row[f]) : '-')).join('×');
        sizes.set(k, (sizes.get(k) ?? 0) + 1);
      }
      const top = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(', ');
      parts.push(`${unmatched.length} in ${sizes.size} size(s) [${shown.join('×')}: ${top}${sizes.size > 4 ? ', …' : ''}] — add a ${def.typeTable} row per size (or use an existing one) and set type_id`);
    }
    out.push(`[hint] ${table}: ${raw.length} row(s) without type_id; ${parts.join('; ')}`);
  }

  for (const table of MARKED) {
    const unmarked: Raw[] = [];
    for (const d of dirs) {
      for (const row of rowsOf(join(d.path, `${table}.csv`))) {
        if (!(row.number ?? '').trim()) unmarked.push({ at: `${d.name}/${row.id}`, id: row.id, row });
      }
    }
    if (unmarked.length > 0) {
      out.push(`[hint] ${table}: ${unmarked.length} row(s) without a number (mark: tags and schedules show it; unique project-wide): ${ids(unmarked)}`);
    }
  }
  return out;
}
