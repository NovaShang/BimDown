import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistry, getSpecDir, GEOJSON_FILE_NAMES } from '../schema/registry.js';
import type { ResolvedTable } from '../schema/types.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { readCsv, type CsvData } from '../utils/csv.js';
import { validateStructure } from './structure.js';
import { validateCsvHeaders, validateCsvRequired, validateCsvEnums } from './csv.js';
import { validateIdFormat, createIdRegistry, registerIds } from './ids.js';
import { validateReferences } from './references.js';
import { validateRanges } from './ranges.js';
import { projectUnits } from '../utils/units.js';
import { validateGeoJsonFile } from './geojson.js';
import { catalogFromEntries, typeSuppliedFields, validateTypes } from './types.js';

interface CsvEntry {
  path: string;       // relative display path
  fullPath: string;
  tableName: string;
  table: ResolvedTable;
  data: CsvData;
}

export function validate(dir: string): string[] {
  const issues: string[] = [];

  // 1. Structure validation
  issues.push(...validateStructure(dir));

  const registry = buildRegistry(getSpecDir());
  const layout = discoverLayout(dir);

  // Collect all CSVs
  const csvEntries: CsvEntry[] = [];
  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);
    for (const f of files) {
      if (!f.endsWith('.csv')) continue;
      const tableName = f.replace('.csv', '');
      const table = registry.get(tableName);
      if (!table) continue;

      const fullPath = join(d.path, f);
      const relPath = `${d.name}/${f}`;

      let data: CsvData;
      try {
        data = readCsv(fullPath);
      } catch (e) {
        issues.push(`${relPath}  failed to read CSV: ${(e as Error).message}`);
        continue;
      }

      csvEntries.push({ path: relPath, fullPath, tableName, table, data });
    }
  }

  // 2-3. CSV header and required field validation (a typed row may leave the
  // fields its type supplies empty)
  const catalog = catalogFromEntries(csvEntries);
  for (const entry of csvEntries) {
    const supplied = entry.table.typeTable
      ? (row: Record<string, string>) => typeSuppliedFields(entry.table, row, catalog)
      : undefined;
    issues.push(...validateCsvHeaders(entry.path, entry.table, entry.data, supplied));
    issues.push(...validateCsvRequired(entry.path, entry.table, entry.data, supplied));
  }

  // 4. ID format validation
  for (const entry of csvEntries) {
    issues.push(...validateIdFormat(entry.path, entry.table, entry.data));
  }

  // 5. ID uniqueness (global)
  const idRegistry = createIdRegistry();
  for (const entry of csvEntries) {
    registerIds(idRegistry, entry.path, entry.tableName, entry.data);
  }
  issues.push(...idRegistry.issues);

  // 6. Enum validation
  for (const entry of csvEntries) {
    issues.push(...validateCsvEnums(entry.path, entry.table, entry.data));
  }

  // 7. Reference validation
  for (const entry of csvEntries) {
    issues.push(...validateReferences(entry.path, entry.table, entry.data, idRegistry));
  }

  // 7b. Element types: layers, thermal values, type_id targets, enum values supplied by types
  issues.push(...validateTypes(csvEntries, catalog, idRegistry));

  // 8. Value range validation (catches unit mistakes; limits are scaled to the project unit)
  const units = projectUnits(dir);
  for (const entry of csvEntries) {
    issues.push(...validateRanges(entry.path, entry.table, entry.data, units));
  }

  // 8b. Hosted element position validation (must be a non-negative distance)
  for (const entry of csvEntries) {
    if (!entry.table.hostType) continue;
    for (let i = 0; i < entry.data.rows.length; i++) {
      const row = entry.data.rows[i];
      const pos = row.position;
      if (pos === undefined || pos === '') continue;
      const val = Number(pos);
      if (isNaN(val) || val < 0) {
        issues.push(
          `${entry.path}:${i + 2}  position=${pos} must be a non-negative distance`,
        );
      }
    }
  }

  // 9. GeoJSON validation
  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);
    for (const f of files) {
      if (!f.endsWith('.geojson')) continue;
      const base = f.replace('.geojson', '');
      const tableEntry = Object.entries(GEOJSON_FILE_NAMES).find(([, v]) => v === base);
      if (!tableEntry) continue;
      const [tableName] = tableEntry;
      const table = registry.get(tableName);
      if (!table) continue;

      // Gather CSV IDs for this table in this partition (global or current level)
      const csvIds = new Set<string>();
      for (const entry of csvEntries) {
        if (entry.tableName !== tableName) continue;
        const entryDir = entry.path.split('/')[0];
        if (entryDir !== d.name) continue;
        for (const row of entry.data.rows) {
          if (row.id) csvIds.add(row.id);
        }
      }

      const fullPath = join(d.path, f);
      const relPath = `${d.name}/${f}`;
      issues.push(...validateGeoJsonFile(relPath, fullPath, csvIds, tableName, units));
    }
  }

  return issues;
}
