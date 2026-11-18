import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  stringifyFeatureCollection,
  type BimDownFeature,
  type BimDownFeatureCollection,
} from '../utils/geojson.js';
import { dirFiles } from '../utils/fs.js';
import { projectUnits } from '../utils/units.js';
import { collectBoundaryLines, roomNetArea, unitsPerMetre, type BoundaryLine } from './room-area.js';
import type { Face, RoomIssue } from './room-faces.js';
import { deriveLevelRooms, type ProjectFiles } from './project-rooms.js';

export type { RoomIssue };

export interface SpaceBoundaryResult {
  warnings: string[];
  geojsonWritten: boolean;
  roomIssues: RoomIssue[];
}

// ─── Main entry point ───────────────────────────────────

/**
 * Rooms of one level folder: faces, seed matching and overlap / leak checks
 * (build/project-rooms.ts, the same code as the IFC importer's report), then
 * space.geojson with each room's net area. Global boundary elements count when
 * `globalDir` is given.
 */
export function computeSpaceBoundaries(
  levelDir: { name: string; path: string },
  globalDir?: string,
): SpaceBoundaryResult {
  const root = dirname(levelDir.path);
  const all = dirFiles(root);
  const files: ProjectFiles = globalDir ? all : { read: (p) => (p.startsWith('global/') ? undefined : all.read(p)), write: all.write };
  const { warnings, rooms } = deriveLevelRooms(files, levelDir.name);
  const roomIssues: RoomIssue[] = rooms ? [...rooms.roomIssues] : [];
  if (!rooms || rooms.matched.size === 0) return { warnings, geojsonWritten: false, roomIssues };

  // space.geojson (with each room's net area at the wall faces)
  const lines = collectBoundaryLines(levelDir.path);
  if (globalDir) lines.push(...collectBoundaryLines(globalDir));
  // Redundant rooms: every seed but the first in a shared area (area counted once).
  const redundant = new Set(rooms.roomIssues.filter((r) => r.kind === 'shared').flatMap((r) => r.spaceIds.slice(1)));
  writeSvg(levelDir.path, rooms.matched, lines, unitsPerMetre(projectUnits(root)), redundant);
  return { warnings, geojsonWritten: true, roomIssues };
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
