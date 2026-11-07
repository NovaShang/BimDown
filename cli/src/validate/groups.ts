/**
 * Model groups (model_group.csv in a level directory + `group_id` on the
 * members). Generic reference validation already checks that a `group_id`
 * names an existing `mg-` row; here: the group lives on the member's own
 * level, its numbers parse and it has members. `groupWarnings` (build) flags
 * instances of one group whose member sets differ.
 */
import type { CsvData } from '../utils/csv.js';
import type { IdRegistry } from './ids.js';

interface Entry {
  path: string;
  tableName: string;
  data: CsvData;
}

const NUMERIC = ['x', 'y', 'rotation'];

export function validateGroups(entries: readonly Entry[], registry: IdRegistry): string[] {
  const issues: string[] = [];
  // "level/mg-1" → member count
  const members = new Map<string, number>();
  for (const e of entries) {
    if (e.tableName === 'model_group' || !e.data.headers.includes('group_id')) continue;
    const level = e.path.split('/')[0];
    e.data.rows.forEach((row, i) => {
      const gid = (row.group_id ?? '').trim();
      if (!gid) return;
      if (level === 'global') {
        issues.push(`${e.path}:${i + 2}  group_id "${gid}": elements in global/ cannot be grouped (groups belong to one level)`);
        return;
      }
      const g = registry.ids.get(`${level}/${gid}`);
      if (registry.allIds.has(gid) && (!g || g.table !== 'model_group')) {
        issues.push(`${e.path}:${i + 2}  group_id "${gid}" is not a model_group on ${level}`);
        return;
      }
      members.set(`${level}/${gid}`, (members.get(`${level}/${gid}`) ?? 0) + 1);
    });
  }
  for (const e of entries) {
    if (e.tableName !== 'model_group') continue;
    const level = e.path.split('/')[0];
    e.data.rows.forEach((row, i) => {
      const at = `${e.path}:${i + 2}`;
      for (const f of NUMERIC) {
        const v = row[f];
        if (v !== undefined && v !== '' && !Number.isFinite(Number(v))) issues.push(`${at}  ${f}="${v}" is not a number`);
      }
      if (row.id && !members.has(`${level}/${row.id}`)) issues.push(`${at}  model group "${row.id}" has no members (no element has group_id=${row.id})`);
    });
  }
  return issues;
}

/**
 * Instances sharing a name should hold the same members (per table). A
 * mismatch is a warning: the files stay valid, but editing the group in an
 * editor will make the instances identical again.
 */
export function groupWarnings(entries: readonly Entry[]): string[] {
  // "level/mg-1" → name
  const nameOf = new Map<string, string>();
  for (const e of entries) {
    if (e.tableName !== 'model_group') continue;
    const level = e.path.split('/')[0];
    for (const row of e.data.rows) if (row.id) nameOf.set(`${level}/${row.id}`, row.name ?? '');
  }
  if (nameOf.size === 0) return [];
  // instance → "table×n" counts
  const counts = new Map<string, Map<string, number>>();
  for (const key of nameOf.keys()) counts.set(key, new Map());
  for (const e of entries) {
    if (e.tableName === 'model_group' || !e.data.headers.includes('group_id')) continue;
    const level = e.path.split('/')[0];
    for (const row of e.data.rows) {
      const c = counts.get(`${level}/${(row.group_id ?? '').trim()}`);
      if (c) c.set(e.tableName, (c.get(e.tableName) ?? 0) + 1);
    }
  }
  const signature = (c: Map<string, number>) => [...c].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${n} ${t}`).join(', ');
  const byName = new Map<string, { key: string; sig: string }[]>();
  for (const [key, name] of nameOf) {
    const list = byName.get(name) ?? [];
    list.push({ key, sig: signature(counts.get(key)!) });
    byName.set(name, list);
  }
  const warnings: string[] = [];
  for (const [name, list] of byName) {
    const first = list[0];
    for (const other of list.slice(1)) {
      if (other.sig !== first.sig) {
        warnings.push(`model group "${name}": ${other.key} (${other.sig || 'empty'}) differs from ${first.key} (${first.sig || 'empty'})`);
      }
    }
  }
  return warnings;
}
