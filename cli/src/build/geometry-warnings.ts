import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistry, getSpecDir, GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { discoverLayout } from '../utils/fs.js';
import { readCsv } from '../utils/csv.js';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';

const TOLERANCE = 0.01; // 1cm

/** Tables whose SVG line segments form room boundaries */
const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

export function validateGeometry(dir: string): string[] {
  const warnings: string[] = [];
  const registry = buildRegistry(getSpecDir());
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

function validateLineConnectivity(levelDir: { name: string; path: string }): string[] {
  const warnings: string[] = [];

  interface Endpoint {
    x: number;
    y: number;
    side: 'start' | 'end';
    elementId: string;
    table: string;
  }

  interface Segment {
    start_x: number;
    start_y: number;
    end_x: number;
    end_y: number;
    elementId: string;
    table: string;
  }

  const endpoints: Endpoint[] = [];
  const segments: Segment[] = [];

  for (const table of BOUNDARY_TABLES) {
    const geomName = GEOJSON_FILE_NAMES[table];
    if (!geomName) continue;
    const path = join(levelDir.path, `${geomName}.geojson`);
    if (!existsSync(path)) continue;
    try {
      const fc = parseGeoJsonFile(path);
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const lg = extractLineGeometry(f);
        endpoints.push({ x: lg.start_x, y: lg.start_y, side: 'start', elementId: id, table });
        endpoints.push({ x: lg.end_x, y: lg.end_y, side: 'end', elementId: id, table });
        segments.push({ start_x: lg.start_x, start_y: lg.start_y, end_x: lg.end_x, end_y: lg.end_y, elementId: id, table });
      }
    } catch { /* skip */ }
  }

  // For each endpoint, check if it connects to another element — either at an endpoint or on a segment (T-junction)
  for (const ep of endpoints) {
    // Check endpoint-to-endpoint connection
    const hasEndpointNeighbor = endpoints.some(
      (other) =>
        other !== ep &&
        !(other.elementId === ep.elementId && other.table === ep.table) &&
        Math.abs(other.x - ep.x) < TOLERANCE &&
        Math.abs(other.y - ep.y) < TOLERANCE,
    );

    if (hasEndpointNeighbor) continue;

    // Check T-junction: endpoint falls on another segment's line
    const hasTJunction = segments.some((seg) => {
      if (seg.elementId === ep.elementId && seg.table === ep.table) return false;
      return pointOnSegment(ep.x, ep.y, seg.start_x, seg.start_y, seg.end_x, seg.end_y, TOLERANCE);
    });

    if (hasTJunction) continue;

    // No connection found — emit warning
    let nearestDist = Infinity;
    let nearestId = '';
    let nearestSide = '';
    for (const other of endpoints) {
      if (other === ep || (other.elementId === ep.elementId && other.table === ep.table)) continue;
      const dx = other.x - ep.x;
      const dy = other.y - ep.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestId = other.elementId;
        nearestSide = other.side;
      }
    }

    const nearestInfo =
      nearestDist < Infinity
        ? ` (nearest: ${nearestId} ${nearestSide}, distance ${nearestDist.toFixed(3)}m)`
        : '';

    warnings.push(
      `[warn] ${levelDir.name}/${ep.table}.geojson  ${ep.elementId} ${ep.side} (${ep.x.toFixed(3)}, ${ep.y.toFixed(3)}) has no connected line element${nearestInfo}`,
    );
  }

  return warnings;
}

/** Check if point (px, py) lies on the line segment from (ax, ay) to (bx, by) within tolerance */
function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, tol: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < tol * tol) return false; // degenerate segment

  // Project point onto line, get parameter t
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < -tol || t > 1 + tol) return false; // outside segment

  // Distance from point to closest point on segment
  const clampedT = Math.max(0, Math.min(1, t));
  const closestX = ax + clampedT * dx;
  const closestY = ay + clampedT * dy;
  const distSq = (px - closestX) * (px - closestX) + (py - closestY) * (py - closestY);
  return distSq < tol * tol;
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
