import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverLayout } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';

/** Tables whose marks must be unique project-wide, and the group they share (curtain wall door panels number with doors). */
const GROUPS: Record<string, string> = { door: 'door', curtain_wall: 'door', window: 'window', space: 'space' };

/**
 * Duplicate marks across the project (Revit "duplicate Mark values"): a door,
 * curtain wall door panel (`door_numbers`), window or room number used more
 * than once. One warning per duplicated number.
 */
export function numberWarnings(dir: string): string[] {
  const layout = discoverLayout(dir);
  const seen = new Map<string, string[]>(); // group|number → "lv-1/door.csv:3"
  const dirs = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs];
  for (const d of dirs) {
    for (const table of Object.keys(GROUPS)) {
      const path = join(d.path, `${table}.csv`);
      if (!existsSync(path)) continue;
      let rows: Record<string, string>[];
      try { rows = readCsv(path).rows; } catch { continue; }
      rows.forEach((row, i) => {
        const marks = table === 'curtain_wall' ? (row.door_numbers ?? '').split(';') : [row.number ?? ''];
        for (const raw of marks) {
          const n = raw.trim();
          if (!n) continue;
          const k = `${GROUPS[table]}|${n}`;
          const at = `${d.name}/${table}.csv:${i + 2}`;
          const list = seen.get(k);
          if (list) list.push(at); else seen.set(k, [at]);
        }
      });
    }
  }
  const out: string[] = [];
  for (const [k, at] of seen) {
    if (at.length < 2) continue;
    const [group, n] = k.split('|');
    out.push(`${at[0]}  ${group} number "${n}" is used ${at.length} times (${at.join(', ')})`);
  }
  return out;
}
