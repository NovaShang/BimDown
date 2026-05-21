import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';
import { readCsv, writeCsv } from '../utils/csv.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';

const TOLERANCE = 0.05; // 5cm snap tolerance for finding nearest wall

interface WallGeo {
  id: string;
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
  length: number;
}

const HOSTED_TABLES = ['door', 'window', 'opening'];

/**
 * Pre-build step: resolve host_x/host_y to host_id + position.
 * For each hosted element row that has host_x/host_y but missing position,
 * find the nearest wall and compute position along it.
 * Writes resolved values back to CSV.
 */
export function resolveHostedCoords(dir: string): string[] {
  const issues: string[] = [];
  const layout = discoverLayout(dir);

  const allDirs = [
    { name: 'global', path: layout.globalDir },
    ...layout.levelDirs,
  ];

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    const files = listFiles(d.path);

    // Collect wall geometries for this level
    const walls: WallGeo[] = [];
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
          walls.push({
            id,
            start_x: lg.start_x, start_y: lg.start_y,
            end_x: lg.end_x, end_y: lg.end_y,
            length: lg.length,
          });
        }
      } catch { /* skip */ }
    }

    if (walls.length === 0) continue;

    // Process each hosted table
    for (const table of HOSTED_TABLES) {
      const csvPath = join(d.path, `${table}.csv`);
      if (!files.includes(`${table}.csv`)) continue;

      const csv = readCsv(csvPath);
      const hasHostX = csv.headers.includes('host_x');
      const hasHostY = csv.headers.includes('host_y');
      if (!hasHostX || !hasHostY) continue;

      let modified = false;

      for (let i = 0; i < csv.rows.length; i++) {
        const row = csv.rows[i];
        const hostX = parseFloat(row.host_x ?? '');
        const hostY = parseFloat(row.host_y ?? '');

        // Skip if no host_x/host_y
        if (isNaN(hostX) || isNaN(hostY)) continue;

        // Skip if position already set
        const existingPosition = parseFloat(row.position ?? '');
        if (!isNaN(existingPosition) && row.position !== '') continue;

        // Find the nearest wall to this point
        const match = findNearestWall(hostX, hostY, walls, row.host_id);

        if (!match) {
          issues.push(
            `${d.name}/${table}.csv:${i + 2}  ${row.id} host_x=${hostX}, host_y=${hostY} — no wall found within ${TOLERANCE}m`,
          );
          continue;
        }

        // Write resolved values
        row.position = match.position.toFixed(4);
        if (!row.host_id || row.host_id === '') {
          row.host_id = match.wallId;
        }
        modified = true;
      }

      if (modified) {
        // Ensure host_id and position columns exist, remove host_x/host_y
        const cleanHeaders = csv.headers.filter(h => h !== 'host_x' && h !== 'host_y');
        if (!cleanHeaders.includes('host_id')) {
          // Insert host_id after 'id' column
          const idIdx = cleanHeaders.indexOf('id');
          cleanHeaders.splice(idIdx + 1, 0, 'host_id');
        }
        if (!cleanHeaders.includes('position')) {
          const hostIdx = cleanHeaders.indexOf('host_id');
          cleanHeaders.splice(hostIdx + 1, 0, 'position');
        }
        const cleanRows = csv.rows.map(row => {
          const clean: Record<string, string> = {};
          for (const h of cleanHeaders) {
            if (row[h] !== undefined) clean[h] = row[h];
          }
          return clean;
        });
        writeCsv(csvPath, { headers: cleanHeaders, rows: cleanRows });
      }
    }
  }

  return issues;
}

function findNearestWall(
  px: number,
  py: number,
  walls: WallGeo[],
  preferredHostId?: string,
): { wallId: string; position: number } | null {
  let bestWallId = '';
  let bestPosition = 0;
  let bestDist = Infinity;

  for (const wall of walls) {
    const dx = wall.end_x - wall.start_x;
    const dy = wall.end_y - wall.start_y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) continue;

    // Project point onto wall line
    const t = ((px - wall.start_x) * dx + (py - wall.start_y) * dy) / lenSq;
    const clampedT = Math.max(0, Math.min(1, t));

    const closestX = wall.start_x + clampedT * dx;
    const closestY = wall.start_y + clampedT * dy;
    const dist = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);

    // If host_id is specified, only match that wall
    if (preferredHostId && preferredHostId !== '') {
      if (wall.id === preferredHostId) {
        return { wallId: wall.id, position: clampedT * wall.length };
      }
      continue;
    }

    if (dist < bestDist) {
      bestDist = dist;
      bestWallId = wall.id;
      bestPosition = clampedT * wall.length;
    }
  }

  if (bestDist > TOLERANCE && !preferredHostId) return null;
  if (!bestWallId) return null;

  return { wallId: bestWallId, position: bestPosition };
}
