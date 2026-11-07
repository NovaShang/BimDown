/**
 * Net room area from a project folder: reads the boundary lines (with their
 * effective thickness) that `room-net-area.ts` offsets rooms by.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseGeoJsonFile, extractLineGeometry } from '../utils/geojson.js';
import { readCsv } from '../utils/csv.js';
import { effectiveRows } from '../catalog/index.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { UNIT_TO_M } from '../utils/units.js';

export { netRoomOutline, roomNetArea, type BoundaryLine } from './room-net-area.js';
import type { BoundaryLine } from './room-net-area.js';

const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

/** Boundary lines of one level (or global/) folder with their effective thickness. */
export function collectBoundaryLines(dirPath: string): BoundaryLine[] {
  const out: BoundaryLine[] = [];
  const projectDir = dirname(dirPath);
  for (const table of BOUNDARY_TABLES) {
    const geomPath = join(dirPath, `${GEOJSON_FILE_NAMES[table] ?? table}.geojson`);
    if (!existsSync(geomPath)) continue;
    const thickness = new Map<string, number>();
    const csvPath = join(dirPath, `${table}.csv`);
    if (table !== 'room_separator' && existsSync(csvPath)) {
      try {
        for (const r of effectiveRows(projectDir, table, readCsv(csvPath).rows)) {
          const t = parseFloat(r.thickness ?? '');
          if (r.id && Number.isFinite(t) && t > 0) thickness.set(r.id, t);
        }
      } catch { /* unreadable CSV: walls count as thin */ }
    }
    try {
      for (const f of parseGeoJsonFile(geomPath).features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        const lg = extractLineGeometry(f);
        out.push({
          start: { x: lg.start_x, y: lg.start_y }, end: { x: lg.end_x, y: lg.end_y },
          half: table === 'room_separator' ? 0 : (thickness.get(id) ?? 0) / 2,
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

/** Model units per metre for a project unit name. */
export function unitsPerMetre(unit: string): number {
  return 1 / (UNIT_TO_M[unit as keyof typeof UNIT_TO_M] ?? 1);
}
