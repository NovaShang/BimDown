/** BimDown project files (path → text) from the converted elements. */
import type { ImportContext, OutEl, AttrValue } from './context.js';
import { r3 } from './math.js';

/** Leading CSV columns per table (the rest follow in first-seen order). */
const LEAD = ['id', 'number', 'name', 'type_id', 'host_id', 'base_level_id', 'top_level_id'];

function fmt(v: AttrValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(r3(v)) : '';
  return String(v).replace(/[\r\n]+/g, ' ').trim();
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: { id: string; attrs: Record<string, AttrValue> }[]): string {
  const cols: string[] = [];
  const seen = new Set<string>(['id']);
  for (const r of rows) for (const [k, v] of Object.entries(r.attrs)) if (!seen.has(k) && fmt(v) !== '') { seen.add(k); cols.push(k); }
  const ordered = ['id', ...LEAD.filter(c => c !== 'id' && seen.has(c)), ...cols.filter(c => !LEAD.includes(c))];
  const lines = [ordered.join(',')];
  for (const r of rows) lines.push(ordered.map(c => csvCell(c === 'id' ? r.id : fmt(r.attrs[c]))).join(','));
  return lines.join('\n') + '\n';
}

function toGeoJson(els: OutEl[]): string | null {
  const feats = els.filter(e => e.geometry);
  if (feats.length === 0) return null;
  const lines = ['{', '  "type": "FeatureCollection",', '  "features": ['];
  feats.forEach((e, i) => {
    const props: Record<string, unknown> = { id: e.id };
    for (const [k, v] of Object.entries(e.props)) if (v !== undefined && v !== null) props[k] = v;
    lines.push('    ' + JSON.stringify({ type: 'Feature', properties: props, geometry: e.geometry }) + (i === feats.length - 1 ? '' : ','));
  });
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

export interface EmitOptions {
  projectName: string;
  source: string;
}

const DISCIPLINE_TABLES: Record<string, string[]> = {
  mep: ['duct', 'pipe', 'cable_tray', 'conduit', 'equipment', 'terminal', 'mep_node'],
  structure: ['structure_column', 'structure_wall', 'structure_slab', 'beam', 'brace', 'foundation'],
  architecture: ['wall', 'curtain_wall', 'door', 'window', 'opening', 'slab', 'roof', 'ceiling', 'stair', 'ramp', 'railing', 'column', 'furniture'],
};

/** The discipline a model is about (an MEP or structural model), for the editor to open in; spaces and separators don't count. */
export function dominantDiscipline(els: { table: string }[]): 'mep' | 'structure' | undefined {
  const n: Record<string, number> = { mep: 0, structure: 0, architecture: 0 };
  for (const el of els) for (const [d, ts] of Object.entries(DISCIPLINE_TABLES)) if (ts.includes(el.table)) n[d]++;
  if (n.mep > 0 && n.mep >= 4 * (n.architecture + n.structure)) return 'mep';
  if (n.structure > 0 && n.structure >= 2 * n.architecture && n.structure > n.mep) return 'structure';
  return undefined;
}

export function emitFiles(ctx: ImportContext, opts: EmitOptions): Record<string, string> {
  const files: Record<string, string> = {};
  files['project_metadata.json'] = JSON.stringify({
    format_version: '3.0', units: 'm', spatial_z: 'absolute', project_name: opts.projectName, source: opts.source,
    discipline: dominantDiscipline(ctx.out),
  }, null, 2) + '\n';
  files['global/level.csv'] = toCsv(ctx.levels.map(l => ({ id: l.id, attrs: { number: l.number, name: l.name, elevation: r3(l.elevation) } })));
  const groups = new Map<string, OutEl[]>();
  for (const el of ctx.out) {
    const dir = el.global ? 'global' : ctx.levels[el.level]?.id ?? 'global';
    const key = `${dir}/${el.table}`;
    const l = groups.get(key);
    if (l) l.push(el); else groups.set(key, [el]);
  }
  for (const [key, els] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    files[`${key}.csv`] = toCsv(els);
    const gj = toGeoJson(els);
    if (gj) files[`${key}.geojson`] = gj;
  }
  return files;
}
