#!/usr/bin/env node
/**
 * Repair sample_data/rac_advanced (a 2026-03 Revit export, migrated to GeoJSON
 * in 2026-05) so `bimdown validate` reports no issues. Each step only touches
 * rows that still have the problem, so re-running it is a no-op.
 *
 *   node scripts/fix-rac-advanced.mjs [dir]     (default sample_data/rac_advanced)
 *
 * 1. level.number: filled from the level name ("01 - Entry Level" -> "01").
 * 2. Column / beam `shape` (required): the old exporter left it empty. A section
 *    with only size_x is a diameter -> round; otherwise rect (the current
 *    exporter's fallback, SectionMapper).
 * 3. opening.csv: drop the computed `level_id` column. The slab openings on lv-2 /
 *    lv-3 were exported with their host's id (sl-1 / sl-2) and the SVG -> GeoJSON
 *    migration then gave all four the same polygon; restore the four loops from the
 *    original SVG (stairs and lift) with op-N ids.
 * 4. Drop rows with no geometry at all: lv-1 op-2 / op-3 (no host, a zero-area
 *    sketch), lv-1 op-1 (wall opening without position or size), lv-2 d-100 (door
 *    0 x 0 with no position) and the three Topography mesh rows (no mesh file).
 * 5. mesh.csv: the lv-1 Furniture and Planting rows had ids that collide with the
 *    shade supports (ms-1..ms-75 counted twice) and no or wrong mesh files (chairs
 *    pointing at the shade-support GLB). They become built-in `furniture` rows
 *    (chairs, round tables, trees, shrubs) with one furniture_type per Revit
 *    family type, so the names survive. Revit rotations face +Y; furniture faces -Y.
 * 6. Wall / curtain wall / room separator ends that stop at another wall's face
 *    (Revit joins) are extended to its location line, so rooms close (hosted
 *    positions follow a moved start).
 * 7. GLB files nothing references any more are deleted.
 * 8. _IdMap.csv follows the renames and drops the deleted ids.
 * 9. `bimdown build` (cli/dist, run `npm run build` in cli/ first) recomputes the
 *    room polygons in space.geojson from the repaired walls.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'sample_data', 'rac_advanced');
const changed = [];

// ─── CSV / GeoJSON I/O (same output format as the CLI writers) ─────────────

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function readCsv(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  let text = readFileSync(p, 'utf-8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const v = parseLine(l); const r = {};
    headers.forEach((h, i) => { r[h] = v[i] ?? ''; });
    return r;
  });
  return { rel, bom, headers, rows };
}
function writeCsv(t) {
  const text = (t.bom ? '﻿' : '') + [t.headers.join(','), ...t.rows.map((r) => t.headers.map((h) => esc(r[h] ?? '')).join(','))].join('\n') + '\n';
  writeIfChanged(t.rel, text);
}
function readGeo(rel) {
  const p = join(root, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : { type: 'FeatureCollection', features: [] };
}
function writeGeo(rel, fc) {
  const f = fc.features;
  const text = ['{', '  "type": "FeatureCollection",', '  "features": [', ...f.map((x, i) => '    ' + JSON.stringify(x) + (i < f.length - 1 ? ',' : '')), '  ]', '}'].join('\n') + '\n';
  writeIfChanged(rel, text);
}
function writeIfChanged(rel, text) {
  const p = join(root, rel);
  if (existsSync(p) && readFileSync(p, 'utf-8') === text) return;
  writeFileSync(p, text, 'utf-8');
  changed.push(rel);
}
function remove(rel) {
  const p = join(root, rel);
  if (existsSync(p)) { unlinkSync(p); changed.push(`${rel} (deleted)`); }
}

const renamed = new Map(); // old IdMap key -> new id
const deleted = new Set();

// ─── 1. level numbers ───────────────────────────────────────────────────────

{
  const t = readCsv('global/level.csv');
  const named = { Roof: 'R', Parapet: 'P' };
  for (const r of t.rows) {
    if (r.number) continue;
    r.number = /^(\d+)\s*-/.exec(r.name)?.[1] ?? named[r.name] ?? r.id;
  }
  writeCsv(t);
}

// ─── 2. section shapes ──────────────────────────────────────────────────────

for (const rel of ['lv-1/structure_column.csv', 'lv-2/structure_column.csv', 'lv-3/structure_column.csv', 'global/beam.csv']) {
  const t = readCsv(rel);
  if (!t) continue;
  for (const r of t.rows) {
    if (r.shape) continue;
    r.shape = r.size_x && !r.size_y ? 'round' : 'rect';
  }
  writeCsv(t);
}

// ─── 3 + 4. openings ────────────────────────────────────────────────────────

// Inner loops of slabs sl-1 (lv-2) and sl-2 (lv-3), from the original opening.svg.
const SLAB_LOOPS = [
  [[4.031, 6.626], [4.031, -1.299], [1.21, -1.299], [1.21, 6.626]],
  [[4.031, -4.347], [4.031, -12.272], [1.21, -12.272], [1.21, -4.347]],
  [[4.021, 17.599], [4.021, 9.674], [1.231, 9.674], [1.231, 17.599]],
  [[9.014, -15.07], [10.878, -15.07], [10.878, -17.246], [9.014, -17.246]],
];

for (const level of ['lv-1', 'lv-2', 'lv-3']) {
  const t = readCsv(`${level}/opening.csv`);
  if (!t) continue;
  const geo = readGeo(`${level}/opening.geojson`);
  t.headers = t.headers.filter((h) => h !== 'level_id');

  // Openings with nothing to cut: no host and no polygon, or a wall opening without a size.
  const polys = new Set(geo.features.filter((f) => f.geometry?.type === 'Polygon').map((f) => f.properties.id));
  t.rows = t.rows.filter((r) => {
    const empty = (!r.host_id && !r.top_level_id && !polys.has(r.id)) || (r.host_id?.startsWith('w-') && !(Number(r.width) > 0));
    if (empty) deleted.add(r.id);
    return !empty;
  });

  // Slab openings carrying their host's id
  const bad = t.rows.filter((r) => !r.id.startsWith('op-'));
  if (bad.length) {
    let n = Math.max(0, ...t.rows.map((r) => Number(/^op-(\d+)$/.exec(r.id)?.[1] ?? 0)));
    if (bad.length !== SLAB_LOOPS.length || new Set(bad.map((r) => r.id)).size !== 1) throw new Error(`${level}: unexpected openings ${bad.map((r) => r.id)}`);
    geo.features = geo.features.filter((f) => f.properties.id.startsWith('op-'));
    bad.forEach((r, i) => {
      r.id = `op-${++n}`;
      const ring = [...SLAB_LOOPS[i], SLAB_LOOPS[i][0]];
      geo.features.push({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'Polygon', coordinates: [ring] } });
    });
  }
  geo.features = geo.features.filter((f) => t.rows.some((r) => r.id === f.properties.id));
  if (t.rows.length === 0) { remove(`${level}/opening.csv`); remove(`${level}/opening.geojson`); continue; }
  writeCsv(t);
  writeGeo(`${level}/opening.geojson`, geo);
}

{
  const t = readCsv('lv-2/door.csv');
  t.rows = t.rows.filter((r) => {
    const empty = !(Number(r.width) > 0) && !(Number(r.height) > 0) && !r.position;
    if (empty) deleted.add(r.id);
    return !empty;
  });
  writeCsv(t);
}

// ─── 5. mesh rows -> furniture ──────────────────────────────────────────────

const TYPES = {
  'M_Chair-Breuer': { family: 'chair', size_x: '0.43', size_y: '0.49', height: '0.81' }, // from the chair GLB (ms-43)
  '0915mm Diameter': { family: 'dining_table', variant: 'round', size_x: '0.915', size_y: '0.915' },
  'Scarlet Oak - 12.5 Meters': { family: 'tree', height: '12.5' },
  'Honey Locust - 7.6 Meters': { family: 'tree', height: '7.6' },
  'Red Maple - 9 Meters': { family: 'tree', height: '9' },
  'Golden Chain - 5.5 Meters': { family: 'tree', height: '5.5' },
  'Japanese Cherry - 4.5 Meters': { family: 'tree', height: '4.5' },
  'Barberry - 1.0 Meters': { family: 'plant', height: '1' },
  'Golden Flame Spirea - 0.8 Meters': { family: 'plant', height: '0.8' },
};

{
  const mesh = readCsv('global/mesh.csv');
  const isFurniture = (r) => r.level_id === 'lv-1' && (r.category === 'Furniture' || r.category === 'Planting') && TYPES[r.name];
  const isEmpty = (r) => !r.mesh_file && !isFurniture(r);
  const moving = mesh.rows.filter(isFurniture);
  for (const r of mesh.rows.filter(isEmpty)) deleted.add(r.id);

  if (moving.length) {
    const typeT = readCsv('global/furniture_type.csv') ?? { rel: 'global/furniture_type.csv', bom: false, headers: ['id', 'name', 'family', 'variant', 'size_x', 'size_y', 'height'], rows: [] };
    const furn = readCsv('lv-1/furniture.csv') ?? { rel: 'lv-1/furniture.csv', bom: false, headers: ['id', 'number', 'mesh_file', 'type_id'], rows: [] };
    const fgeo = readGeo('lv-1/furniture.geojson');
    const typeId = new Map(typeT.rows.map((r) => [r.name, r.id]));
    for (const r of moving) {
      if (!typeId.has(r.name)) {
        const id = `fut-${typeT.rows.length + 1}`;
        typeT.rows.push({ id, name: r.name, ...TYPES[r.name] });
        typeId.set(r.name, id);
      }
      const id = `fu-${furn.rows.length + 1}`;
      furn.rows.push({ id, type_id: typeId.get(r.name) });
      const props = { id };
      const rot = ((Number(r.rotation) || 0) + 180) % 360;
      if (rot) props.rotation = rot;
      const z = Number(r.z) || 0;
      if (z) props.base_offset = z;
      fgeo.features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [Number(r.x), Number(r.y)] } });
      // ids repeat between the two groups; _IdMap tells them apart by block (step 8)
      renamed.set(`${r.category === 'Planting' ? 'planting' : 'furniture'}:${r.id}`, id);
    }
    writeCsv(typeT);
    writeCsv(furn);
    writeGeo('lv-1/furniture.geojson', fgeo);
  }
  mesh.rows = mesh.rows.filter((r) => !isFurniture(r) && !isEmpty(r));
  writeCsv(mesh);
}

// ─── 6. wall ends stopping at another wall's face ──────────────────────────
// Revit joins an interior wall to the face of the wall (or curtain wall) it runs
// into; BimDown connects location lines, so those ends leave a gap that merges the
// rooms on both sides. Extend each free end along its own direction to the first
// location line within SNAP (straight 2-point lines only, which is all this model has).

{
  const SNAP = 0.35;
  const LINE_TABLES = ['wall', 'curtain_wall', 'room_separator'];
  const HOSTED = ['door', 'window', 'opening'];
  const load = (dir) => LINE_TABLES.flatMap((t) => {
    const rel = `${dir}/${t}.geojson`;
    if (!existsSync(join(root, rel))) return [];
    const fc = readGeo(rel);
    return fc.features.filter((f) => f.geometry?.type === 'LineString' && f.geometry.coordinates.length === 2).map((f) => ({ rel, fc, f, c: f.geometry.coordinates }));
  });
  const segDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const ray = (p, d, a, b) => {
    const ex = b[0] - a[0], ey = b[1] - a[1], den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-9) return null;
    const wx = a[0] - p[0], wy = a[1] - p[1];
    const s = (wx * ey - wy * ex) / den, u = (wx * d[1] - wy * d[0]) / den;
    return s > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 ? s : null;
  };
  const round = (v) => Math.round(v * 1000) / 1000;
  const levels = readCsv('global/level.csv').rows.map((r) => r.id).filter((id) => existsSync(join(root, id)));
  const globals = load('global');
  for (const dir of [...levels, 'global']) {
    const own = dir === 'global' ? globals : load(dir);
    const targets = dir === 'global' ? globals : [...own, ...globals];
    const touched = new Set();
    const startShift = new Map(); // element id -> metres its start moved back
    for (const e of own) {
      for (const end of [0, 1]) {
        const p = e.c[end], q = e.c[1 - end];
        if (targets.some((o) => o !== e && segDist(p, o.c[0], o.c[1]) < 0.01)) continue;
        const len = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const d = [(p[0] - q[0]) / len, (p[1] - q[1]) / len];
        let best = null;
        for (const o of targets) {
          if (o === e) continue;
          const s = ray(p, d, o.c[0], o.c[1]);
          if (s !== null && s <= SNAP && (best === null || s < best)) best = s;
        }
        if (best === null) continue;
        e.c[end] = [round(p[0] + d[0] * best), round(p[1] + d[1] * best), ...p.slice(2)];
        touched.add(e.rel);
        if (end === 0) startShift.set(e.f.properties.id, best);
      }
    }
    for (const rel of touched) writeGeo(rel, own.find((e) => e.rel === rel).fc);
    if (startShift.size && dir !== 'global') {
      for (const t of HOSTED) {
        const h = readCsv(`${dir}/${t}.csv`);
        if (!h) continue;
        for (const r of h.rows) if (startShift.has(r.host_id) && r.position) r.position = String(round(Number(r.position) + startShift.get(r.host_id)));
        writeCsv(h);
      }
    }
  }
}

// ─── 7. GLB files nothing references any more ───────────────────────────────

{
  const refs = new Set();
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel), { withFileTypes: true })) {
      const sub = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(sub);
      else if (name.name.endsWith('.csv')) for (const r of readCsv(sub).rows) if (r.mesh_file) refs.add(r.mesh_file);
    }
  };
  walk('');
  if (existsSync(join(root, 'mesh'))) {
    for (const f of readdirSync(join(root, 'mesh'))) if (f.endsWith('.glb') && !refs.has(`mesh/${f}`)) remove(`mesh/${f}`);
  }
}

// ─── 8. _IdMap ──────────────────────────────────────────────────────────────

{
  const t = readCsv('_IdMap.csv');
  // ms ids in _IdMap: shade supports / potted plants ms-1..42, then Planting
  // ms-46..75, then lv-1 Furniture ms-1..75, then lv-3 furniture ms-76.. .
  // A deleted id is dropped only when unambiguous (ids are unique per level only).
  const count = new Map();
  for (const r of t.rows) count.set(r.id, (count.get(r.id) ?? 0) + 1);
  let block = 'mesh';
  let prev = 0;
  t.rows = t.rows.filter((r) => {
    const m = /^ms-(\d+)$/.exec(r.id);
    if (m) {
      const n = Number(m[1]);
      if (n !== prev + 1) block = block === 'mesh' && prev === 42 ? 'planting' : block === 'planting' ? 'furniture' : block;
      if (block === 'furniture' && n > 75) block = 'done';
      prev = n;
      const to = renamed.get(`${block}:${r.id}`);
      if (to) { r.id = to; return true; }
    }
    return !(deleted.has(r.id) && count.get(r.id) === 1);
  });
  writeCsv(t);
}

// ─── 9. room polygons ───────────────────────────────────────────────────────

{
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('build the CLI first (cd cli && npm run build), then re-run');
  const before = ['lv-1', 'lv-2', 'lv-3'].map((l) => existsSync(join(root, l, 'space.geojson')) ? readFileSync(join(root, l, 'space.geojson'), 'utf-8') : '');
  execFileSync(process.execPath, [cli, 'build', root], { stdio: 'ignore' });
  ['lv-1', 'lv-2', 'lv-3'].forEach((l, i) => { if (existsSync(join(root, l, 'space.geojson')) && readFileSync(join(root, l, 'space.geojson'), 'utf-8') !== before[i]) changed.push(`${l}/space.geojson`); });
}

console.log(changed.length ? `updated:\n  ${changed.join('\n  ')}` : 'already clean, nothing to do');
