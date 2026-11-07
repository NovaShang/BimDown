import { join } from 'node:path';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import { groupWarnings } from '../validate/groups.js';

/** Read the level CSVs and report model group instances that diverged. */
export function groupWarningsForDir(dir: string): string[] {
  const layout = discoverLayout(dir);
  const entries = [];
  for (const d of layout.levelDirs) {
    const files = listFiles(d.path).filter(f => f.endsWith('.csv'));
    if (!files.includes('model_group.csv')) continue;
    for (const f of files) {
      try {
        entries.push({ path: `${d.name}/${f}`, tableName: f.replace('.csv', ''), data: readCsv(join(d.path, f)) });
      } catch { /* unreadable CSVs are reported by validate */ }
    }
  }
  return groupWarnings(entries);
}
