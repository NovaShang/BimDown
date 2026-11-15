import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { discoverLayout } from '../utils/fs.js';
import { projectUnits } from '../utils/units.js';
import { readCsv } from '../utils/csv.js';
import { effectiveRows } from '../catalog/index.js';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';
import { insertOverlaps, wallOverlaps, type CheckInsert, type CheckWall } from './model-checks.js';

const TOLERANCE = 0.01; // 1cm

/** Tables whose SVG line segments form room boundaries */
const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

export function validateGeometry(dir: string): string[] {
  const warnings: string[] = [];
  const layout = discoverLayout(dir);
  // Distances in messages are in the project's units
  const unit = projectUnits(dir);

  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  // Collect all wall geometries (for hosted bounds checking)
  const wallGeometries = new Map<string, { length: number }>();
  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    for (const table of ['wall', 'structure_wall', 'curtain_wall']) {
      const geomName = GEOJSON_FILE_NAMES[table];
      if (!geomName) continue;
      const path = join(d.path, `${geomName}.geojson`);
      if (!existsSync(path)) continue;
      try {
        const fc = parseGeoJsonFile(path);
        for (const f of fc.features) {
          if (f.geometry.type !== 'LineString') continue;
          const id = String(f.properties?.id ?? '');
          if (!id) continue;
          const lg = extractLineGeometry(f);
          wallGeometries.set(id, { length: lg.length });
        }
      } catch { /* skip */ }
    }
  }

  // Per-level checks
  for (const d of [...layout.levelDirs]) {
    if (!existsSync(d.path)) continue;

    // A. Line connectivity
    warnings.push(...validateLineConnectivity(d, unit));

    // B. Hosted bounds
    warnings.push(...validateHostedBounds(d, wallGeometries, unit));

    // C. Hosted overlap
    warnings.push(...validateHostedOverlap(d, unit));

    // D. Overlapping walls
    warnings.push(...validateWallOverlap(d, unit));
  }

  return warnings;
}

// ─── A. Line connectivity ───────────────────────────────

/** Extra slack (m) when deciding that a wall end touches another wall's body or a column. */
const TOUCH_SLACK = 0.02;
const COLUMN_TABLES = ['column', 'structure_column'];

/**
 * A boundary-line end is connected when it meets another line's end, lands anywhere on another wall's
 * body (T-junction at the centre line or at the face, within that wall's half thickness), or ends on a
 * column. Only ends that touch nothing are reported — those are the gaps that keep rooms from closing.
 */
function validateLineConnectivity(levelDir: { name: string; path: string }, unit: string): string[] {
  const warnings: string[] = [];

  interface Endpoint { x: number; y: number; side: 'start' | 'end'; elementId: string; table: string }
  interface Segment { ax: number; ay: number; bx: number; by: number; half: number; elementId: string; table: string }
  interface Box { x0: number; y0: number; x1: number; y1: number }

  const endpoints: Endpoint[] = [];
  const segments: Segment[] = [];
  const columns: Box[] = [];

  const csvRows = (table: string): Map<string, Record<string, string>> => {
    const m = new Map<string, Record<string, string>>();
    const p = join(levelDir.path, `${table}.csv`);
    if (!existsSync(p)) return m;
    try { for (const r of effectiveRows(dirname(levelDir.path), table, readCsv(p).rows)) if (r.id) m.set(r.id, r); } catch { /* skip */ }
    return m;
  };

  for (const table of BOUNDARY_TABLES) {
    const geomName = GEOJSON_FILE_NAMES[table];
    if (!geomName) continue;
    const path = join(levelDir.path, `${geomName}.geojson`);
    if (!existsSync(path)) continue;
    const attrs = csvRows(table);
    try {
      const fc = parseGeoJsonFile(path);
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const lg = extractLineGeometry(f);
        const t = parseFloat(attrs.get(id)?.thickness ?? '') || 0;
        endpoints.push({ x: lg.start_x, y: lg.start_y, side: 'start', elementId: id, table });
        endpoints.push({ x: lg.end_x, y: lg.end_y, side: 'end', elementId: id, table });
        segments.push({ ax: lg.start_x, ay: lg.start_y, bx: lg.end_x, by: lg.end_y, half: t / 2, elementId: id, table });
      }
    } catch { /* skip */ }
  }

  for (const table of COLUMN_TABLES) {
    const geomName = GEOJSON_FILE_NAMES[table];
    if (!geomName) continue;
    const path = join(levelDir.path, `${geomName}.geojson`);
    if (!existsSync(path)) continue;
    const attrs = csvRows(table);
    try {
      const fc = parseGeoJsonFile(path);
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue;
        const [x, y] = f.geometry.coordinates as number[];
        const r = attrs.get(String(f.properties?.id ?? ''));
        const sx = parseFloat(r?.size_x ?? '') || 0.4;
        const sy = parseFloat(r?.size_y ?? '') || sx;
        const h = Math.max(sx, sy) / 2;     // rotation-safe: use the larger half size
        columns.push({ x0: x - h, y0: y - h, x1: x + h, y1: y + h });
      }
    } catch { /* skip */ }
  }

  const same = (a: { elementId: string; table: string }, b: { elementId: string; table: string }) =>
    a.elementId === b.elementId && a.table === b.table;

  for (const ep of endpoints) {
    const atEndpoint = endpoints.some(
      (o) => o !== ep && !same(o, ep) && Math.abs(o.x - ep.x) < TOLERANCE && Math.abs(o.y - ep.y) < TOLERANCE,
    );
    if (atEndpoint) continue;

    const onWall = segments.some((seg) => !same(seg, ep) &&
      pointNearSegment(ep.x, ep.y, seg.ax, seg.ay, seg.bx, seg.by, Math.max(seg.half, TOLERANCE) + TOUCH_SLACK));
    if (onWall) continue;

    const onColumn = columns.some((c) =>
      ep.x >= c.x0 - TOUCH_SLACK && ep.x <= c.x1 + TOUCH_SLACK && ep.y >= c.y0 - TOUCH_SLACK && ep.y <= c.y1 + TOUCH_SLACK);
    if (onColumn) continue;

    let nearestDist = Infinity;
    let nearestId = '';
    let nearestSide = '';
    for (const other of endpoints) {
      if (other === ep || same(other, ep)) continue;
      const d = Math.hypot(other.x - ep.x, other.y - ep.y);
      if (d < nearestDist) { nearestDist = d; nearestId = other.elementId; nearestSide = other.side; }
    }
    const nearestInfo = nearestDist < Infinity ? ` (nearest: ${nearestId} ${nearestSide}, distance ${nearestDist.toFixed(3)} ${unit})` : '';
    warnings.push(
      `[warn] ${levelDir.name}/${ep.table}.geojson  ${ep.elementId} ${ep.side} (${ep.x.toFixed(3)}, ${ep.y.toFixed(3)}) has no connected line element${nearestInfo}`,
    );
  }

  return warnings;
}

/** Point within `tol` of segment AB, measured to the segment body (ends extended by `tol`). */
function pointNearSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, tol: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const ux = dx / len, uy = dy / len;
  const along = (px - ax) * ux + (py - ay) * uy;
  if (along < -tol || along > len + tol) return false;
  const across = Math.abs(-(px - ax) * uy + (py - ay) * ux);
  return across <= tol;
}

// ─── B. Hosted bounds ───────────────────────────────────

function validateHostedBounds(
  levelDir: { name: string; path: string },
  wallGeometries: Map<string, { length: number }>,
  unit: string,
): string[] {
  const warnings: string[] = [];

  for (const tableName of ['door', 'window']) {
    const csvPath = join(levelDir.path, `${tableName}.csv`);
    if (!existsSync(csvPath)) continue;

    const rows = effectiveRows(dirname(levelDir.path), tableName, readCsv(csvPath).rows);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const hostId = row.host_id;
      const position = parseFloat(row.position ?? '');
      const width = parseFloat(row.width ?? '');

      if (!hostId || isNaN(position) || isNaN(width)) continue;

      const wallGeo = wallGeometries.get(hostId);
      if (!wallGeo) continue; // host not found in SVG, reference validator handles this

      const halfWidth = width / 2;
      if (position - halfWidth < -TOLERANCE) {
        warnings.push(
          `[warn] ${levelDir.name}/${tableName}.csv:${i + 2}  ${row.id} extends before host ${hostId} start: position(${position}) - width/2(${halfWidth.toFixed(3)}) = ${(position - halfWidth).toFixed(3)} ${unit}`,
        );
      }
      if (position + halfWidth > wallGeo.length + TOLERANCE) {
        warnings.push(
          `[warn] ${levelDir.name}/${tableName}.csv:${i + 2}  ${row.id} extends past host ${hostId} end: position(${position}) + width/2(${halfWidth.toFixed(3)}) = ${(position + halfWidth).toFixed(3)} ${unit} > wall length ${wallGeo.length.toFixed(3)} ${unit}`,
        );
      }
    }
  }

  return warnings;
}

// ─── C. Hosted overlap ──────────────────────────────────

/** Default sill / height when a row leaves them empty (as the editor's 3D: windows sit at 0.9 m). */
const INSERT_DEFAULTS: Record<string, { sill: number; height: number }> = {
  door: { sill: 0, height: 2.1 }, window: { sill: 0.9, height: 1.2 }, opening: { sill: 0, height: 2.1 },
};

function validateHostedOverlap(levelDir: { name: string; path: string }, unit: string): string[] {
  const inserts: CheckInsert[] = [];
  for (const tableName of ['door', 'window', 'opening']) {
    const csvPath = join(levelDir.path, `${tableName}.csv`);
    if (!existsSync(csvPath)) continue;
    const rows = effectiveRows(dirname(levelDir.path), tableName, readCsv(csvPath).rows);
    const d = INSERT_DEFAULTS[tableName];
    for (const row of rows) {
      const position = parseFloat(row.position ?? '');
      const width = parseFloat(row.width ?? '');
      if (!row.host_id || isNaN(position) || isNaN(width)) continue;
      const sill = row.base_offset !== undefined && row.base_offset !== '' ? parseFloat(row.base_offset) || 0 : d.sill;
      const height = parseFloat(row.height ?? '') || d.height;
      inserts.push({ id: row.id, scope: levelDir.name, table: tableName, hostId: row.host_id, position, width, sill, height });
    }
  }
  return insertOverlaps(inserts, TOLERANCE, unit).map((p) => `[warn] ${levelDir.name}/  ${p.message}`);
}

// ─── D. Overlapping walls ───────────────────────────────

function validateWallOverlap(levelDir: { name: string; path: string }, unit: string): string[] {
  const walls: CheckWall[] = [];
  for (const table of ['wall', 'structure_wall']) {
    const geomName = GEOJSON_FILE_NAMES[table];
    const path = join(levelDir.path, `${geomName}.geojson`);
    if (!geomName || !existsSync(path)) continue;
    const thickness = new Map<string, number>();
    const csvPath = join(levelDir.path, `${table}.csv`);
    if (existsSync(csvPath)) {
      try { for (const r of effectiveRows(dirname(levelDir.path), table, readCsv(csvPath).rows)) thickness.set(r.id, parseFloat(r.thickness ?? '') || 0); } catch { /* skip */ }
    }
    try {
      for (const f of parseGeoJsonFile(path).features) {
        if (f.geometry.type !== 'LineString' || f.properties?.arc) continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const lg = extractLineGeometry(f);
        walls.push({ id, scope: levelDir.name, table, a: { x: lg.start_x, y: lg.start_y }, b: { x: lg.end_x, y: lg.end_y }, thickness: thickness.get(id) || 0.2 });
      }
    } catch { /* skip */ }
  }
  return wallOverlaps(walls, TOLERANCE, TOLERANCE * 10, unit).map((p) => `[warn] ${levelDir.name}/  ${p.message}`);
}
