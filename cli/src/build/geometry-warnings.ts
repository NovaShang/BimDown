import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { discoverLayout } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';

const TOLERANCE = 0.01; // 1cm

/** Tables whose SVG line segments form room boundaries */
const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

export function validateGeometry(dir: string): string[] {
  const warnings: string[] = [];
  const layout = discoverLayout(dir);

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
    warnings.push(...validateLineConnectivity(d));

    // B. Hosted bounds
    warnings.push(...validateHostedBounds(d, wallGeometries));

    // C. Hosted overlap
    warnings.push(...validateHostedOverlap(d));
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
function validateLineConnectivity(levelDir: { name: string; path: string }): string[] {
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
    try { for (const r of readCsv(p).rows) if (r.id) m.set(r.id, r); } catch { /* skip */ }
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
    const nearestInfo = nearestDist < Infinity ? ` (nearest: ${nearestId} ${nearestSide}, distance ${nearestDist.toFixed(3)}m)` : '';
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
): string[] {
  const warnings: string[] = [];

  for (const tableName of ['door', 'window']) {
    const csvPath = join(levelDir.path, `${tableName}.csv`);
    if (!existsSync(csvPath)) continue;

    const csv = readCsv(csvPath);
    for (let i = 0; i < csv.rows.length; i++) {
      const row = csv.rows[i];
      const hostId = row.host_id;
      const position = parseFloat(row.position ?? '');
      const width = parseFloat(row.width ?? '');

      if (!hostId || isNaN(position) || isNaN(width)) continue;

      const wallGeo = wallGeometries.get(hostId);
      if (!wallGeo) continue; // host not found in SVG, reference validator handles this

      const halfWidth = width / 2;
      if (position - halfWidth < -TOLERANCE) {
        warnings.push(
          `[warn] ${levelDir.name}/${tableName}.csv:${i + 2}  ${row.id} extends before host ${hostId} start: position(${position}) - width/2(${halfWidth.toFixed(3)}) = ${(position - halfWidth).toFixed(3)}m`,
        );
      }
      if (position + halfWidth > wallGeo.length + TOLERANCE) {
        warnings.push(
          `[warn] ${levelDir.name}/${tableName}.csv:${i + 2}  ${row.id} extends past host ${hostId} end: position(${position}) + width/2(${halfWidth.toFixed(3)}) = ${(position + halfWidth).toFixed(3)}m > wall length ${wallGeo.length.toFixed(3)}m`,
        );
      }
    }
  }

  return warnings;
}

// ─── C. Hosted overlap ──────────────────────────────────

function validateHostedOverlap(levelDir: { name: string; path: string }): string[] {
  const warnings: string[] = [];

  interface HostedEntry {
    id: string;
    hostId: string;
    position: number;
    width: number;
    tableName: string;
    row: number;
  }

  const entries: HostedEntry[] = [];

  for (const tableName of ['door', 'window', 'opening']) {
    const csvPath = join(levelDir.path, `${tableName}.csv`);
    if (!existsSync(csvPath)) continue;

    const csv = readCsv(csvPath);
    for (let i = 0; i < csv.rows.length; i++) {
      const row = csv.rows[i];
      const hostId = row.host_id;
      const position = parseFloat(row.position ?? '');
      const width = parseFloat(row.width ?? '');

      if (!hostId || isNaN(position) || isNaN(width)) continue;
      entries.push({ id: row.id, hostId, position, width, tableName, row: i + 2 });
    }
  }

  // Group by host_id
  const byHost = new Map<string, HostedEntry[]>();
  for (const entry of entries) {
    const list = byHost.get(entry.hostId) ?? [];
    list.push(entry);
    byHost.set(entry.hostId, list);
  }

  // Check pairwise overlap
  for (const [hostId, group] of byHost) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.position - b.position);

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aEnd = a.position + a.width / 2;
        const bStart = b.position - b.width / 2;

        if (aEnd > bStart + TOLERANCE) {
          warnings.push(
            `[warn] ${levelDir.name}/  ${a.id} and ${b.id} overlap on ${hostId} (${a.id}: ${(a.position - a.width / 2).toFixed(3)}–${aEnd.toFixed(3)}m, ${b.id}: ${bStart.toFixed(3)}–${(b.position + b.width / 2).toFixed(3)}m)`,
          );
        }
      }
    }
  }

  return warnings;
}
