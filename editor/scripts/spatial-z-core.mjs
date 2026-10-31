/**
 * Storage-agnostic core of the legacy spatial-Z migration (see
 * migrate-spatial-z.mjs for the rules). Works on an in-memory file map so the
 * CLI (local dir) and the BimClaw API (R2) share one implementation.
 */

export const SPATIAL_LINE_TABLES = ['stair', 'ramp', 'railing', 'beam', 'brace', 'duct', 'pipe', 'cable_tray', 'conduit'];
export const SPATIAL_POINT_TABLES = ['equipment', 'terminal', 'mep_node'];
const SPATIAL_TABLES = new Set([...SPATIAL_LINE_TABLES, ...SPATIAL_POINT_TABLES]);

/** True for the project-relative paths the migration reads. */
export function isMigrationInput(path) {
  if (path === 'project_metadata.json' || path === 'global/level.csv') return true;
  const m = /^[^/]+\/([a-z_]+)\.(geojson|csv)$/.exec(path);
  return !!m && SPATIAL_TABLES.has(m[1]);
}

// ─── CSV (RFC 4180, enough for BimDown files) ───────────────────────────────

export function parseCsv(text) {
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

export function writeCsv({ header, rows }) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

function stringifyFc(fc) {
  const { features = [], ...rest } = fc;
  const head = JSON.stringify({ ...rest, type: 'FeatureCollection' }).slice(1, -1);
  return `{${head},"features":[\n${features.map(f => '  ' + JSON.stringify(f)).join(',\n')}\n]}\n`;
}

function readLevels(files) {
  const text = files.get('global/level.csv');
  if (text == null) return [];
  const { header, rows } = parseCsv(text);
  const id = header.indexOf('id'), el = header.indexOf('elevation');
  return rows.map(r => ({ id: r[id], elevation: parseFloat(r[el]) || 0 }))
    .sort((a, b) => a.elevation - b.elevation);
}

/** Whether a layer's Z values read as absolute or level-relative. */
export function zHint(zs, elevation, nextElevation) {
  if (!zs.length || elevation === 0) return 'n/a';
  const storey = (nextElevation ?? elevation + 4) - elevation;
  const absOk = zs.filter(z => z >= elevation - 1.5 && z <= elevation + storey + 1.5).length;
  const relOk = zs.filter(z => z >= -1.5 && z <= storey + 1.5).length;
  if (absOk === zs.length && relOk < zs.length) return 'absolute';
  if (relOk === zs.length && absOk < zs.length) return 'relative';
  if (relOk === zs.length && absOk === zs.length) return 'ambiguous';
  return 'mixed';
}

export const HINT_TEXT = {
  'n/a': 'n/a',
  absolute: 'reads as absolute — already migrated? check',
  relative: 'reads as level-relative (legacy)',
  ambiguous: 'ambiguous',
  mixed: 'mixed — inspect before applying',
};

/**
 * Plan the migration of one project from its files (Map of project-relative
 * path → text; only {@link isMigrationInput} paths are needed).
 * Returns { status: 'skipped' | 'refused' | 'planned', reason?, changes, writes }
 * where writes is [path, newContent][] including the stamped metadata.
 */
export function planSpatialZMigration(files, { force = false } = {}) {
  const metaText = files.get('project_metadata.json');
  const meta = metaText != null ? JSON.parse(metaText) : {};
  if (meta.spatial_z === 'absolute' && !force) {
    return { status: 'skipped', reason: 'project_metadata.json already has spatial_z: absolute', changes: [], writes: [] };
  }
  if (/revit/i.test(String(meta.source ?? '')) && !force) {
    return { status: 'refused', reason: `source "${meta.source}" is a Revit export (absolute Z); use --force only for layers an old editor re-saved`, changes: [], writes: [] };
  }

  const levels = readLevels(files);
  const changes = [];
  const writes = [];

  const dirs = [{ id: 'global', elevation: 0, next: undefined },
    ...levels.map((l, i) => ({ id: l.id, elevation: l.elevation, next: levels[i + 1]?.elevation }))];
  for (const { id: levelId, elevation, next } of dirs) {
    for (const table of [...SPATIAL_LINE_TABLES, ...SPATIAL_POINT_TABLES]) {
      const geoPath = `${levelId}/${table}.geojson`;
      const csvPath = `${levelId}/${table}.csv`;
      const isPoint = SPATIAL_POINT_TABLES.includes(table);
      const csvText = files.get(csvPath);
      const csv = csvText != null ? parseCsv(csvText) : null;
      const csvBase = new Map();
      if (csv && isPoint) {
        const idI = csv.header.indexOf('id'), boI = csv.header.indexOf('base_offset');
        if (boI >= 0) for (const r of csv.rows) csvBase.set(r[idI], parseFloat(r[boI]));
      }

      const geoText = files.get(geoPath);
      if (geoText != null) {
        const fc = JSON.parse(geoText);
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
          const zMin = before.length ? Math.min(...before) : undefined, zMax = before.length ? Math.max(...before) : undefined;
          const hint = isPoint ? 'n/a' : zHint(before, elevation, next);
          changes.push({
            file: geoPath, level: levelId, elevation, kind: isPoint ? 'points' : 'lines', count: n, zMin, zMax, hint,
            detail: isPoint
              ? `${n} 2D point(s) → 3D at elevation ${elevation} + base_offset`
              : `${n} line(s): z ${zMin}..${zMax} → +${elevation} (${HINT_TEXT[hint]})`,
          });
          writes.push([geoPath, stringifyFc(fc)]);
        }
      }

      if (csv) {
        const drop = new Set(['start_z', 'end_z', ...(isPoint ? ['base_offset'] : [])]);
        const keep = csv.header.map((h, i) => (drop.has(h) ? -1 : i)).filter(i => i >= 0);
        if (keep.length < csv.header.length) {
          const removed = csv.header.filter(h => drop.has(h));
          changes.push({ file: csvPath, level: levelId, elevation, kind: 'columns', detail: `drop column(s) ${removed.join(', ')}` });
          writes.push([csvPath, writeCsv({ header: keep.map(i => csv.header[i]), rows: csv.rows.map(r => keep.map(i => r[i] ?? '')) })]);
        }
      }
    }
  }

  writes.push(['project_metadata.json', markedMetadata(metaText)]);
  return { status: 'planned', changes, writes };
}

/** project_metadata.json content with `spatial_z: "absolute"` stamped in. */
export function markedMetadata(metaText) {
  const meta = metaText != null ? JSON.parse(metaText) : {};
  return JSON.stringify({ ...meta, spatial_z: 'absolute' }, null, 2) + '\n';
}
