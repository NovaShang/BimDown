/**
 * `furniture` checks the schema can't express: the variant must belong to the
 * row's family (the family enum itself is checked by the generic enum pass).
 */
import type { CsvData } from '../utils/csv.js';
import { getFurnitureFamily, variantIds } from './library.js';

export function validateFurnitureRows(path: string, data: CsvData): string[] {
  const issues: string[] = [];
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    const fam = getFurnitureFamily(row.family);
    const variant = row.variant ?? '';
    if (!fam || variant === '') continue;
    const ids = variantIds(fam);
    if (!ids.includes(variant)) {
      issues.push(
        ids.length > 0
          ? `${path}:${i + 2}  variant "${variant}" is not a variant of family "${fam.id}" (${ids.join(', ')})`
          : `${path}:${i + 2}  family "${fam.id}" has no variants; leave variant empty`,
      );
    }
  }
  return issues;
}
