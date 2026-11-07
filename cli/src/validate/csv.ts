import type { ResolvedTable } from '../schema/types.js';
import type { CsvData } from '../utils/csv.js';

export function validateCsvHeaders(
  path: string,
  table: ResolvedTable,
  data: CsvData,
): string[] {
  const issues: string[] = [];
  const expected = new Set(table.csvFields.map((f) => f.name));
  const actual = new Set(data.headers);

  for (const h of data.duplicateHeaders ?? []) {
    issues.push(`${path}  duplicate column "${h}" (merged on read; rewrite the file with one "${h}" column)`);
  }

  for (const h of data.headers) {
    if (!expected.has(h)) {
      issues.push(`${path}  unexpected column "${h}"`);
    }
  }
  for (const f of table.csvFields) {
    if (f.required && !actual.has(f.name)) {
      issues.push(`${path}  missing required column "${f.name}"`);
    }
  }

  return issues;
}

export function validateCsvRequired(
  path: string,
  table: ResolvedTable,
  data: CsvData,
): string[] {
  const issues: string[] = [];
  const requiredFields = table.csvFields.filter((f) => f.required);

  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    for (const f of requiredFields) {
      const val = row[f.name];
      if (val === undefined || val === '') {
        issues.push(`${path}:${i + 2}  required field "${f.name}" is empty`);
      }
    }
  }

  return issues;
}

export function validateCsvEnums(
  path: string,
  table: ResolvedTable,
  data: CsvData,
): string[] {
  const issues: string[] = [];
  const enumFields = table.csvFields.filter((f) => f.type === 'enum' && f.values);

  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    for (const f of enumFields) {
      const val = row[f.name];
      if (val !== undefined && val !== '' && !f.values!.includes(val)) {
        issues.push(
          `${path}:${i + 2}  field "${f.name}" value "${val}" is not a valid enum (${f.values!.join(', ')})`,
        );
      }
    }
  }

  return issues;
}
