import type { ResolvedTable } from '../schema/types.js';
import type { CsvData } from '../utils/csv.js';

export function validateIdFormat(
  path: string,
  table: ResolvedTable,
  data: CsvData,
): string[] {
  const issues: string[] = [];
  const prefix = table.prefix;

  for (let i = 0; i < data.rows.length; i++) {
    const id = data.rows[i].id;
    if (!id) continue; // caught by required check

    // grid/level/mep_system allow any non-empty string after prefix (human-readable
    // identifiers like "sys-chws-main"); other tables require digits only.
    const freeformTables = new Set(['grid', 'level', 'mep_system']);
    const pattern = freeformTables.has(table.name) ? `^${prefix}-.+$` : `^${prefix}-\\d+$`;
    const regex = new RegExp(pattern);
    if (!regex.test(id)) {
      const expected = freeformTables.has(table.name) ? `"${prefix}-{name}"` : `"${prefix}-{n}"`;
      issues.push(`${path}:${i + 2}  id "${id}" has wrong format, expected ${expected}`);
    }
  }

  return issues;
}

export interface IdRegistry {
  // "level/id" -> { table, path, row } for level-scoped uniqueness
  ids: Map<string, { table: string; path: string; row: number }>;
  // All ids across the project (for reference lookups)
  allIds: Map<string, { table: string; path: string; row: number }>;
  issues: string[];
}

export function createIdRegistry(): IdRegistry {
  return { ids: new Map(), allIds: new Map(), issues: [] };
}

export function registerIds(
  registry: IdRegistry,
  path: string,
  tableName: string,
  data: CsvData,
): void {
  // Extract level scope from path (e.g., "lv-1/wall.csv" -> "lv-1")
  const level = path.split('/')[0];

  for (let i = 0; i < data.rows.length; i++) {
    const id = data.rows[i].id;
    if (!id) continue;

    // Level-scoped uniqueness check
    const scopedKey = `${level}/${id}`;
    const existing = registry.ids.get(scopedKey);
    if (existing) {
      if (existing.table === tableName) {
        registry.issues.push(
          `${path}:${i + 2}  duplicate id "${id}" (first seen in ${existing.path}:${existing.row})`,
        );
      } else {
        registry.issues.push(
          `${path}:${i + 2}  id "${id}" conflicts with ${existing.table} in ${existing.path}:${existing.row}`,
        );
      }
    } else {
      registry.ids.set(scopedKey, { table: tableName, path, row: i + 2 });
    }

    // Also register in global lookup (for reference resolution)
    registry.allIds.set(id, { table: tableName, path, row: i + 2 });
  }
}
