import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  extractLineGeometry,
  type BimDownFeature,
  type BimDownFeatureCollection,
} from '../utils/geojson.js';
import { readCsv } from '../utils/csv.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';
import { projectUnits } from '../utils/units.js';
import { collectBoundaryLines, roomNetArea, unitsPerMetre, type BoundaryLine } from './room-area.js';
import { TOLERANCE, deriveRooms, type Face, type RoomIssue, type Segment } from './room-faces.js';

export type { RoomIssue };

/** Boundary element SVG file names to collect line segments from */
const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

export interface SpaceBoundaryResult {
  warnings: string[];
  geojsonWritten: boolean;
  roomIssues: RoomIssue[];
}

// ─── Main entry point ───────────────────────────────────

export function computeSpaceBoundaries(
  levelDir: { name: string; path: string },
  globalDir?: string,
): SpaceBoundaryResult {
  const warnings: string[] = [];
  const roomIssues: RoomIssue[] = [];

  const spaceCsvPath = join(levelDir.path, 'space.csv');
  if (!existsSync(spaceCsvPath)) return { warnings, geojsonWritten: false, roomIssues };

  const spaceCsv = readCsv(spaceCsvPath);
  if (spaceCsv.rows.length === 0) return { warnings, geojsonWritten: false, roomIssues };

  // 1. Collect all boundary line segments (level-local + the global ones standing on this level)
  const segments = collectBoundarySegments(levelDir.path);
  if (globalDir) {
    segments.push(...collectBoundarySegments(globalDir, globalIdsOnLevel(globalDir, levelDir.name)));
  }
  if (segments.length === 0) {
    warnings.push(`${levelDir.name}/  no boundary elements found for space boundary computation`);
    return { warnings, geojsonWritten: false, roomIssues };
  }

  // 2-8. Faces, seed matching and overlap / leak checks
  const seeds = spaceCsv.rows.map((row) => ({
    id: row.id, x: parseFloat(row.x ?? ''), y: parseFloat(row.y ?? ''), raw: [row.x, row.y] as [string, string],
  }));
  const units = projectUnits(dirname(levelDir.path));
  const rooms = deriveRooms(levelDir.name, segments, seeds, units);
  warnings.push(...rooms.warnings);
  roomIssues.push(...rooms.roomIssues);
  const matchedSpaces = rooms.matched;

  if (matchedSpaces.size === 0) return { warnings, geojsonWritten: false, roomIssues };

  // 9. Write space.geojson (with each room's net area at the wall faces)
  const lines = collectBoundaryLines(levelDir.path);
  if (globalDir) lines.push(...collectBoundaryLines(globalDir));
  // Redundant rooms: every seed but the first in a shared area (area counted once).
  const redundant = new Set(rooms.roomIssues.filter((r) => r.kind === 'shared').flatMap((r) => r.spaceIds.slice(1)));
  writeSvg(levelDir.path, matchedSpaces, lines, unitsPerMetre(units), redundant);
  return { warnings, geojsonWritten: true, roomIssues };
}

// ─── Segment collection ─────────────────────────────────

/**
 * Ids of global boundary elements standing on `levelName`: base at or below
 * the level, top above it (a multi-storey wall ending at a level's floor
 * doesn't divide that level's rooms). Null when the levels are unknown (all
 * global elements count, as before).
 */
function globalIdsOnLevel(globalDir: string, levelName: string): Set<string> | null {
  const levelCsv = join(globalDir, 'level.csv');
  if (!existsSync(levelCsv)) return null;
  const levels = readCsv(levelCsv).rows
    .map((r) => ({ id: r.id, elevation: parseFloat(r.elevation ?? '') }))
    .filter((l) => !isNaN(l.elevation))
    .sort((a, b) => a.elevation - b.elevation);
  const here = levels.find((l) => l.id === levelName)?.elevation;
  if (here === undefined) return null;
  const elev = new Map(levels.map((l) => [l.id, l.elevation]));
  const ids = new Set<string>();
  for (const table of BOUNDARY_TABLES) {
    const csvPath = join(globalDir, `${table}.csv`);
    const geomPath = join(globalDir, `${GEOJSON_FILE_NAMES[table] ?? table}.geojson`);
    if (!existsSync(csvPath) || !existsSync(geomPath)) continue;
    const props = new Map<string, Record<string, unknown>>();
    try {
      for (const f of parseGeoJsonFile(geomPath).features) props.set(String(f.properties?.id ?? ''), (f.properties ?? {}) as Record<string, unknown>);
    } catch { continue; }
    for (const row of readCsv(csvPath).rows) {
      const base = elev.get(row.base_level_id ?? '');
      if (base === undefined) { ids.add(row.id); continue; }
      const p = props.get(row.id) ?? {};
      const above = levels.find((l) => l.elevation > base + 1e-6);
      const topLevel = elev.get(row.top_level_id ?? '') ?? above?.elevation;
      const bottom = base + (Number(p.base_offset) || 0);
      const top = topLevel === undefined ? Infinity : topLevel + (Number(p.top_offset) || 0);
      if (bottom <= here + TOLERANCE && top > here + TOLERANCE) ids.add(row.id);
    }
  }
  return ids;
}

function collectBoundarySegments(levelPath: string, only?: Set<string> | null): Segment[] {
  const segments: Segment[] = [];

  for (const table of BOUNDARY_TABLES) {
    const geomName = GEOJSON_FILE_NAMES[table];
    if (!geomName) continue;
    const path = join(levelPath, `${geomName}.geojson`);
    if (!existsSync(path)) continue;

    try {
      const fc = parseGeoJsonFile(path);
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        if (!id || (only && !only.has(id))) continue;
        const lg = extractLineGeometry(f);
        if (lg.length < TOLERANCE) continue;
        segments.push({
          startX: lg.start_x, startY: lg.start_y,
          endX: lg.end_x, endY: lg.end_y,
          id,
        });
      }
    } catch { /* skip */ }
  }

  return segments;
}

// ─── GeoJSON output ─────────────────────────────────────

function writeSvg(levelPath: string, matchedSpaces: Map<string, Face>, lines: BoundaryLine[], upm: number, redundant: Set<string>): void {
  const features: BimDownFeature[] = [];
  for (const [spaceId, face] of matchedSpaces) {
    // Close the ring per RFC 7946
    const ring = face.polygon.map((p) => [
      Number(p.x.toFixed(3)),
      Number(p.y.toFixed(3)),
    ] as [number, number]);
    if (ring.length === 0) continue;
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    features.push({
      type: 'Feature',
      properties: redundant.has(spaceId)
        ? { id: spaceId, net_area: 0, redundant: true }
        : { id: spaceId, net_area: Number(roomNetArea(face.polygon, lines, upm).toFixed(4)) },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  writeFileSync(join(levelPath, 'space.geojson'), stringifyFeatureCollection(fc), 'utf-8');
}
