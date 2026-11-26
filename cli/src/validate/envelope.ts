/**
 * Building envelope checks: roof edge slopes / extrusion profiles against
 * the roof outline, wall top attachment targets, and shafts (openings with a
 * top_level_id) versus hosted openings, and slab slope arrows.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CsvData } from '../utils/csv.js';
import { parseGeoJsonFile, type BimDownFeature } from '../utils/geojson.js';
import type { IdRegistry } from './ids.js';
import { parseSlopeArrow } from '../geo/slab-slope.js';

interface Entry { path: string; tableName: string; data: CsvData }

const ATTACH_TARGETS = new Set(['roof', 'slab', 'structure_slab']);
/** Tables whose outline may be associated with walls (`boundary_walls`), and what they may list. */
const BOUNDED = new Set(['slab', 'structure_slab', 'roof', 'ceiling']);
const BOUNDING = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);
const WALL_HOSTS = new Set(['wall', 'structure_wall', 'curtain_wall']);

/** Features of `<dir>/<file>.geojson` by id (empty when missing / unreadable). */
function features(dirPath: string, file: string): Map<string, BimDownFeature> {
  const out = new Map<string, BimDownFeature>();
  const p = join(dirPath, `${file}.geojson`);
  if (!existsSync(p)) return out;
  try {
    for (const f of parseGeoJsonFile(p).features) out.set(String(f.properties?.id ?? ''), f);
  } catch { /* reported by the GeoJSON validator */ }
  return out;
}

/** Vertices of a polygon's outer ring, without the closing repeat. */
function ringLength(f: BimDownFeature | undefined): number | null {
  if (!f || f.geometry.type !== 'Polygon') return null;
  const ring = f.geometry.coordinates[0] ?? [];
  const n = ring.length;
  if (n >= 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return n - 1;
  return n;
}

export function validateEnvelope(
  dir: string,
  entries: Entry[],
  ids: IdRegistry,
  levelElevation: Map<string, number>,
): string[] {
  const issues: string[] = [];
  for (const e of entries) {
    const levelDir = e.path.split('/')[0];
    const at = (i: number) => `${e.path}:${i + 2}`;
    if (e.tableName === 'roof') {
      const geo = features(join(dir, levelDir), 'roof');
      e.data.rows.forEach((row, i) => {
        const slopes = (row.edge_slopes ?? '').trim();
        if (slopes) {
          const vals = slopes.split(';').map(v => Number(v.trim()));
          if (vals.some(v => !Number.isFinite(v) || v < 0 || v >= 90)) {
            issues.push(`${at(i)}  edge_slopes "${slopes}" must be semicolon-separated slopes in degrees (0 ≤ slope < 90)`);
          }
          const n = ringLength(geo.get(row.id));
          if (n !== null && vals.length !== n) {
            issues.push(`${at(i)}  edge_slopes has ${vals.length} values but the roof outline has ${n} edges (one per edge, edge i from vertex i to i+1)`);
          }
        }
        if (row.roof_type === 'extrusion') {
          const pts = (row.profile ?? '').split(';').filter(s => s.trim()).map(p => p.split(',').map(v => Number(v.trim())));
          if (pts.length < 2 || pts.some(p => p.length !== 2 || !p.every(Number.isFinite))) {
            issues.push(`${at(i)}  extrusion roof needs profile "u,z;u,z;..." with at least two points`);
          }
        }
      });
    }
    if (e.tableName === 'wall' || e.tableName === 'structure_wall') {
      e.data.rows.forEach((row, i) => {
        const target = row.top_attach_id;
        if (!target) return;
        const t = ids.allIds.get(target);
        if (t && !ATTACH_TARGETS.has(t.table)) {
          issues.push(`${at(i)}  top_attach_id "${target}" is a ${t.table}; a wall top attaches to a roof, slab or structure_slab`);
        }
      });
    }
    if (e.tableName === 'slab' || e.tableName === 'structure_slab') {
      // Sloped floor: the slope arrow parses (tail ≠ head)
      e.data.rows.forEach((row, i) => {
        const a = parseSlopeArrow(row.slope_arrow);
        if (typeof a === 'string') issues.push(`${at(i)}  slope_arrow "${row.slope_arrow}" ${a}`);
      });
    }
    if (BOUNDED.has(e.tableName)) {
      // boundary_walls: the walls (same level or global) the outline was picked from
      e.data.rows.forEach((row, i) => {
        for (const id of (row.boundary_walls ?? '').split(';').map(s => s.trim()).filter(Boolean)) {
          const t = ids.ids.get(`${levelDir}/${id}`) ?? ids.ids.get(`global/${id}`);
          if (!t) issues.push(`${at(i)}  boundary_walls: "${id}" is not a wall on ${levelDir} or in global/`);
          else if (!BOUNDING.has(t.table)) issues.push(`${at(i)}  boundary_walls: "${id}" is a ${t.table}; list walls, curtain walls or room separators`);
        }
      });
    }
    if (e.tableName === 'opening') {
      const geo = features(join(dir, levelDir), 'opening');
      e.data.rows.forEach((row, i) => {
        if (row.top_level_id) {
          if (geo.get(row.id)?.geometry.type !== 'Polygon') {
            issues.push(`${at(i)}  a shaft (top_level_id set) needs a Polygon in opening.geojson`);
          }
          const base = levelElevation.get(levelDir), top = levelElevation.get(row.top_level_id);
          const off = (v: string | undefined) => Number(v || 0) || 0;
          if (base !== undefined && top !== undefined && top + off(row.top_offset) <= base + off(row.base_offset)) {
            issues.push(`${at(i)}  shaft top (${row.top_level_id}) must be above its base level`);
          }
        } else if (!row.host_id) {
          issues.push(`${at(i)}  host_id is required (a wall, slab or roof), unless the opening is a shaft with top_level_id`);
        } else if (WALL_HOSTS.has(ids.allIds.get(row.host_id)?.table ?? '') && !(Number(row.width) > 0)) {
          issues.push(`${at(i)}  a wall opening needs width > 0 (and height)`);
        }
      });
    }
  }
  return issues;
}
