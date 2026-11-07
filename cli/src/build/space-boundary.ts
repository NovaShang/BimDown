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

  // 1. Collect all boundary line segments (level-local + global)
  const segments = collectBoundarySegments(levelDir.path);
  if (globalDir) {
    segments.push(...collectBoundarySegments(globalDir));
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
  writeSvg(levelDir.path, matchedSpaces, lines, unitsPerMetre(units));
  return { warnings, geojsonWritten: true, roomIssues };
}

// ─── Segment collection ─────────────────────────────────

function collectBoundarySegments(levelPath: string): Segment[] {
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
        if (!id) continue;
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

function writeSvg(levelPath: string, matchedSpaces: Map<string, Face>, lines: BoundaryLine[], upm: number): void {
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
      properties: { id: spaceId, net_area: Number(roomNetArea(face.polygon, lines, upm).toFixed(4)) },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  writeFileSync(join(levelPath, 'space.geojson'), stringifyFeatureCollection(fc), 'utf-8');
}
