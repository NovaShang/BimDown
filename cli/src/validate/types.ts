/**
 * Element type validation: type tables, type_layer rows, and instance
 * `type_id` references (see catalog/index.ts for the resolution rule).
 */
import type { ResolvedTable } from '../schema/types.js';
import type { CsvData } from '../utils/csv.js';
import type { IdRegistry } from './ids.js';
import { TYPE_TABLES, LAYERED_TYPE_TABLES } from '../schema/registry.js';
import {
  catalogFromRows,
  layerTotal,
  typeOfRow,
  typeParamFields,
  typeValues,
  type TypeCatalog,
} from '../catalog/index.js';

export interface TypedCsvEntry {
  path: string;
  tableName: string;
  table: ResolvedTable;
  data: CsvData;
}

/** Catalog from the global/ type tables among the collected CSVs. */
export function catalogFromEntries(entries: TypedCsvEntry[]): TypeCatalog {
  const global = entries.filter((e) => e.path.startsWith('global/'));
  return catalogFromRows(
    global.filter((e) => TYPE_TABLES.has(e.tableName)).map((e) => ({ table: e.tableName, rows: e.data.rows })),
    global.find((e) => e.tableName === 'type_layer')?.data.rows ?? [],
  );
}

/**
 * Fields of `row` that its type supplies (non-empty type value). Used to relax
 * required-field checks: a typed wall may leave `thickness` empty.
 */
export function typeSuppliedFields(
  table: ResolvedTable,
  row: Record<string, string>,
  catalog: TypeCatalog,
): Set<string> {
  const t = table.typeTable ? typeOfRow(table.name, row, catalog) : undefined;
  if (!t) return new Set();
  const values = typeValues(t);
  return new Set(typeParamFields(table.name).filter((f) => values[f] !== undefined));
}

const inRange01 = (v: number) => v >= 0 && v <= 1;

export function validateTypes(
  entries: TypedCsvEntry[],
  catalog: TypeCatalog,
  idRegistry: IdRegistry,
): string[] {
  const issues: string[] = [];

  for (const entry of entries) {
    const { path, tableName, table, data } = entry;

    // ── type_layer rows ──
    if (tableName === 'type_layer') {
      const seqs = new Map<string, Set<number>>();
      data.rows.forEach((row, i) => {
        const at = `${path}:${i + 2}`;
        const typeId = row.type_id ?? '';
        const t = catalog.types.get(typeId);
        if (typeId && idRegistry.allIds.has(typeId) && (!t || !LAYERED_TYPE_TABLES.has(t.table))) {
          issues.push(`${at}  type_id "${typeId}" is not a layered type (${[...LAYERED_TYPE_TABLES].join(', ')})`);
        }
        const seq = Number(row.seq);
        if (row.seq !== undefined && row.seq !== '') {
          if (!Number.isInteger(seq) || seq < 1) {
            issues.push(`${at}  seq=${row.seq} must be a positive integer`);
          } else {
            const used = seqs.get(typeId) ?? new Set<number>();
            if (used.has(seq)) issues.push(`${at}  seq=${seq} repeats within type ${typeId}`);
            used.add(seq);
            seqs.set(typeId, used);
          }
        }
        const th = Number(row.thickness);
        if (row.thickness && (!Number.isFinite(th) || th <= 0)) {
          issues.push(`${at}  thickness=${row.thickness} must be > 0`);
        }
        const k = Number(row.conductivity);
        if (row.conductivity && (!Number.isFinite(k) || k <= 0)) {
          issues.push(`${at}  conductivity=${row.conductivity} must be > 0 (W/(m·K))`);
        }
      });
      continue;
    }

    // ── type tables ──
    if (TYPE_TABLES.has(tableName)) {
      data.rows.forEach((row, i) => {
        const at = `${path}:${i + 2}`;
        const t = catalog.types.get(row.id ?? '');
        if (t && LAYERED_TYPE_TABLES.has(tableName)) {
          const total = layerTotal(t);
          const own = Number(row.thickness);
          if (row.thickness && total !== undefined && Number.isFinite(own) && Math.abs(own - total) > 5e-4) {
            issues.push(`${at}  ${row.id} thickness=${row.thickness} differs from its layers' total ${total} — fix it or leave thickness empty`);
          }
          if (!row.thickness && total === undefined) {
            issues.push(`${at}  ${row.id} has neither a thickness nor type_layer rows`);
          }
        }
        for (const f of ['shgc', 'vt']) {
          const v = Number(row[f]);
          if (row[f] && (!Number.isFinite(v) || !inRange01(v))) issues.push(`${at}  ${f}=${row[f]} must be between 0 and 1`);
        }
        const u = Number(row.u_value);
        if (row.u_value && (!Number.isFinite(u) || u <= 0)) issues.push(`${at}  u_value=${row.u_value} must be > 0 (W/(m²·K))`);
      });
      continue;
    }

    // ── instance rows with a type_id ──
    if (!table.typeTable || !data.headers.includes('type_id')) continue;
    const params = typeParamFields(tableName);
    const enumFields = table.csvFields.filter((f) => f.type === 'enum' && f.values && params.includes(f.name));
    data.rows.forEach((row, i) => {
      const typeId = row.type_id;
      if (!typeId) return;
      const at = `${path}:${i + 2}`;
      const target = idRegistry.allIds.get(typeId);
      if (target && target.table !== table.typeTable) {
        issues.push(`${at}  type_id "${typeId}" is a ${target.table}; ${tableName} takes a ${table.typeTable}`);
        return;
      }
      const t = typeOfRow(tableName, row, catalog);
      if (!t) return;
      const values = typeValues(t);
      for (const f of enumFields) {
        if ((row[f.name] ?? '') !== '') continue; // instance value checked by the enum pass
        const v = values[f.name];
        if (v !== undefined && !f.values!.includes(v)) {
          issues.push(`${at}  type ${typeId} gives ${f.name}="${v}", which ${tableName} does not accept (${f.values!.join(', ')})`);
        }
      }
    });
  }

  return issues;
}
