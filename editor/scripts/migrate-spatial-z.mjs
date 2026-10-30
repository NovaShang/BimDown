#!/usr/bin/env node
/**
 * One-shot migration: legacy level-relative spatial Z → absolute Z (spec §4.2).
 *
 * Before the `spatial_z` marker, the BimDown editor saved spatial geometry
 * (beam, brace, stair, ramp, railing, duct, pipe, cable_tray, conduit) with Z
 * relative to the level of the directory it sits in, and spatial points
 * (equipment, terminal, mep_node) as 2D points + base_offset. The spec — and
 * the editor since the marker — store absolute Z in the coordinates.
 *
 * Usage:
 *   node scripts/migrate-spatial-z.mjs <project_dir>            # dry run: report only
 *   node scripts/migrate-spatial-z.mjs <project_dir> --apply    # rewrite files + stamp marker
 *   ... --force   also run when the gate says no (see below)
 *
 * Gate (what makes it one-shot and idempotent):
 *   - project_metadata.json has "spatial_z": "absolute" → already absolute; nothing to do.
 *   - "source" mentions Revit → Revit exports are absolute; refuse (only layers an
 *     old editor re-saved are relative — inspect them and use --force if needed).
 *   On --apply the script writes "spatial_z": "absolute", so a second run is a no-op.
 *
 * What changes (level directories only; global/ sits at elevation 0):
 *   - spatial LineString coordinates: z += level elevation
 *   - spatial 2D Points: [x, y] + base_offset → [x, y, elevation + base_offset]
 *     (base_offset property and CSV column removed); 3D Points are left as is —
 *     old editors ignored their Z, so it was never written relative
 *   - CSV start_z / end_z columns of spatial tables (computed fields) are dropped
 * Levels at elevation 0 need no Z change. The dry run prints per-layer Z ranges
 * with a hint whether they read as absolute or relative; a file may be mixed if
 * an agent added absolute geometry after an editor save — check before --apply.
 *
 * Never run this against production data without a backup.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPATIAL_LINE_TABLES = ['stair', 'ramp', 'railing', 'beam', 'brace', 'duct', 'pipe', 'cable_tray', 'conduit'];
const SPATIAL_POINT_TABLES = ['equipment', 'terminal', 'mep_node'];

// ─── CSV (RFC 4180, enough for BimDown files) ───────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length && rows[0].length && rows[0][0].charCodeAt(0) === 0xfeff) rows[0][0] = rows[0][0].slice(1);
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

function csvCell(v) {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function writeCsv({ header, rows }) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

// ─── project reading ────────────────────────────────────────────────────────

function readLevels(dir) {
  const p = join(dir, 'global', 'level.csv');
  if (!existsSync(p)) return [];
  const { header, rows } = parseCsv(readFileSync(p, 'utf-8'));
  const id = header.indexOf('id'), el = header.indexOf('elevation');
  return rows.map(r => ({ id: r[id], elevation: parseFloat(r[el]) || 0 }))
    .sort((a, b) => a.elevation - b.elevation);
}

function stringifyFc(fc) {
  const { features = [], ...rest } = fc;
  const head = JSON.stringify({ ...rest, type: 'FeatureCollection' }).slice(1, -1);
  return `{${head},"features":[\n${features.map(f => '  ' + JSON.stringify(f)).join(',\n')}\n]}\n`;
}

/** Hint whether a layer's Z values read as absolute or level-relative. */
function zHint(zs, elevation, nextElevation) {
  if (!zs.length || elevation === 0) return 'n/a';
  const storey = (nextElevation ?? elevation + 4) - elevation;
  const absOk = zs.filter(z => z >= elevation - 1.5 && z <= elevation + storey + 1.5).length;
  const relOk = zs.filter(z => z >= -1.5 && z <= storey + 1.5).length;
  if (absOk === zs.length && relOk < zs.length) return 'reads as absolute — already migrated? check';
  if (relOk === zs.length && absOk < zs.length) return 'reads as level-relative (legacy)';
  if (relOk === zs.length && absOk === zs.length) return 'ambiguous';
  return 'mixed — inspect before applying';
}

/**
 * Plan (and with apply=true, perform) the migration of one project directory.
 * Returns { status, reason?, changes: [{ file, detail }] }.
 */
export function migrateProject(dir, { apply = false, force = false } = {}) {
  const metaPath = join(dir, 'project_metadata.json');
  let meta = {};
  if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  if (meta.spatial_z === 'absolute' && !force) {
    return { status: 'skipped', reason: 'project_metadata.json already has spatial_z: absolute', changes: [] };
  }
  if (/revit/i.test(String(meta.source ?? '')) && !force) {
    return { status: 'refused', reason: `source "${meta.source}" is a Revit export (absolute Z); use --force only for layers an old editor re-saved`, changes: [] };
  }

  const levels = readLevels(dir);
  const changes = [];
  const writes = [];

  const dirs = [{ id: 'global', elevation: 0, next: undefined },
    ...levels.map((l, i) => ({ id: l.id, elevation: l.elevation, next: levels[i + 1]?.elevation }))];
  for (const { id: levelId, elevation, next } of dirs) {
    const levelDir = join(dir, levelId);
    if (!existsSync(levelDir)) continue;

    for (const table of [...SPATIAL_LINE_TABLES, ...SPATIAL_POINT_TABLES]) {
      const geoPath = join(levelDir, `${table}.geojson`);
      const csvPath = join(levelDir, `${table}.csv`);
      const isPoint = SPATIAL_POINT_TABLES.includes(table);
      const csv = existsSync(csvPath) ? parseCsv(readFileSync(csvPath, 'utf-8')) : null;
      const csvBase = new Map();
      if (csv && isPoint) {
        const idI = csv.header.indexOf('id'), boI = csv.header.indexOf('base_offset');
        if (boI >= 0) for (const r of csv.rows) csvBase.set(r[idI], parseFloat(r[boI]));
      }

      if (existsSync(geoPath)) {
        const fc = JSON.parse(readFileSync(geoPath, 'utf-8'));
        const before = [];
        let n = 0;
        for (const ft of fc.features ?? []) {
          const g = ft.geometry;
          if (!isPoint && g?.type === 'LineString') {
            const has3d = g.coordinates.some(c => c.length >= 3);
            if (!has3d) continue;
            for (const c of g.coordinates) if (c.length >= 3) { before.push(c[2]); if (elevation !== 0) c[2] = +(c[2] + elevation).toFixed(6); }
            if (elevation !== 0) n++;
          } else if (isPoint && g?.type === 'Point' && g.coordinates.length === 2) {
            const fromProp = typeof ft.properties?.base_offset === 'number' ? ft.properties.base_offset : undefined;
            const fromCsv = csvBase.get(ft.properties?.id);
            const bo = fromProp ?? (Number.isFinite(fromCsv) ? fromCsv : 0);
            g.coordinates = [g.coordinates[0], g.coordinates[1], +(elevation + bo).toFixed(6)];
            if (ft.properties) delete ft.properties.base_offset;
            n++;
          }
        }
        if (n > 0) {
          const lo = before.length ? Math.min(...before) : undefined, hi = before.length ? Math.max(...before) : undefined;
          changes.push({
            file: `${levelId}/${table}.geojson`,
            detail: isPoint
              ? `${n} 2D point(s) → 3D at elevation ${elevation} + base_offset`
              : `${n} line(s): z ${lo}..${hi} → +${elevation} (${zHint(before, elevation, next)})`,
          });
          writes.push([geoPath, stringifyFc(fc)]);
        }
      }

      if (csv) {
        const drop = new Set(['start_z', 'end_z', ...(isPoint ? ['base_offset'] : [])]);
        const keep = csv.header.map((h, i) => (drop.has(h) ? -1 : i)).filter(i => i >= 0);
        if (keep.length < csv.header.length) {
          const removed = csv.header.filter(h => drop.has(h));
          changes.push({ file: `${levelId}/${table}.csv`, detail: `drop column(s) ${removed.join(', ')}` });
          writes.push([csvPath, writeCsv({ header: keep.map(i => csv.header[i]), rows: csv.rows.map(r => keep.map(i => r[i] ?? '')) })]);
        }
      }
    }
  }

  if (apply) {
    for (const [p, content] of writes) writeFileSync(p, content, 'utf-8');
    writeFileSync(metaPath, JSON.stringify({ ...meta, spatial_z: 'absolute' }, null, 2) + '\n', 'utf-8');
  }
  return { status: apply ? 'applied' : 'dry-run', changes };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !existsSync(dir) || !readdirSync(dir).includes('global')) {
    console.error('usage: node migrate-spatial-z.mjs <bimdown_project_dir> [--apply] [--force]');
    process.exit(2);
  }
  const res = migrateProject(dir, { apply: args.includes('--apply'), force: args.includes('--force') });
  if (res.reason) console.log(`${res.status}: ${res.reason}`);
  for (const c of res.changes) console.log(`  ${c.file}: ${c.detail}`);
  if (res.status === 'dry-run') console.log(res.changes.length ? 'dry run — rerun with --apply to write' : 'dry run — nothing to change (marker will still be stamped on --apply)');
  if (res.status === 'applied') console.log(`applied ${res.changes.length} change(s); stamped spatial_z: absolute`);
}
