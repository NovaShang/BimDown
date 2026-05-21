import { parseGeoJsonFile, featureId, type BimDownFeature } from '../utils/geojson.js';
import { SPATIAL_3D_TABLES } from '../schema/registry.js';

/** Expected GeoJSON geometry type(s) per table */
const EXPECTED_GEOMETRY: Record<string, Set<'Point' | 'LineString' | 'Polygon'>> = {
  // Line elements → LineString
  wall: new Set(['LineString']),
  structure_wall: new Set(['LineString']),
  curtain_wall: new Set(['LineString']),
  room_separator: new Set(['LineString']),
  stair: new Set(['LineString']),
  ramp: new Set(['LineString']),
  railing: new Set(['LineString']),
  beam: new Set(['LineString']),
  brace: new Set(['LineString']),
  duct: new Set(['LineString']),
  pipe: new Set(['LineString']),
  cable_tray: new Set(['LineString']),
  conduit: new Set(['LineString']),
  // Point elements → Point
  column: new Set(['Point']),
  structure_column: new Set(['Point']),
  equipment: new Set(['Point']),
  terminal: new Set(['Point']),
  mep_node: new Set(['Point']),
  // Polygon elements → Polygon
  slab: new Set(['Polygon']),
  roof: new Set(['Polygon']),
  ceiling: new Set(['Polygon']),
  structure_slab: new Set(['Polygon']),
  space: new Set(['Polygon']),
  // Mixed
  foundation: new Set(['Point', 'LineString', 'Polygon']),
  opening: new Set(['Polygon']),
};

export function validateGeoJsonFile(
  displayPath: string,
  fullPath: string,
  csvIds: Set<string>,
  tableName: string,
): string[] {
  const issues: string[] = [];

  let fc;
  try {
    fc = parseGeoJsonFile(fullPath);
  } catch (e) {
    issues.push(`${displayPath}  failed to parse GeoJSON: ${(e as Error).message}`);
    return issues;
  }

  const isSpatial = SPATIAL_3D_TABLES.has(tableName);
  const expected = EXPECTED_GEOMETRY[tableName];
  const seenIds = new Set<string>();

  for (let i = 0; i < fc.features.length; i++) {
    const feat = fc.features[i] as BimDownFeature;
    const ctx = `${displayPath}:feature[${i}]`;

    if (!feat || feat.type !== 'Feature') {
      issues.push(`${ctx}  not a Feature object`);
      continue;
    }

    const id = featureId(feat);
    if (!id || id === '<unknown>') {
      issues.push(`${ctx}  missing properties.id`);
      continue;
    }
    if (seenIds.has(id)) {
      issues.push(`${ctx}  duplicate id "${id}"`);
    }
    seenIds.add(id);

    if (!csvIds.has(id)) {
      issues.push(`${ctx}  id "${id}" has no matching CSV row`);
    }

    const g = feat.geometry;
    if (!g || !g.type) {
      issues.push(`${ctx}  missing geometry`);
      continue;
    }

    if (expected && !expected.has(g.type as any)) {
      const allowed = [...expected].join(' or ');
      issues.push(`${ctx}  id "${id}" geometry type ${g.type} not allowed for ${tableName} (expected ${allowed})`);
    }

    issues.push(...validateGeometryCoords(ctx, id, g, isSpatial));
  }

  return issues;
}

function validateGeometryCoords(
  ctx: string,
  id: string,
  g: { type: string; coordinates: any },
  isSpatial: boolean,
): string[] {
  const issues: string[] = [];

  const checkPosition = (p: any, where: string) => {
    if (!Array.isArray(p) || p.length < 2 || p.length > 3) {
      issues.push(`${ctx}  id "${id}" ${where} position must be [x,y] or [x,y,z]`);
      return;
    }
    for (let k = 0; k < p.length; k++) {
      const v = p[k];
      if (typeof v !== 'number' || !isFinite(v)) {
        issues.push(`${ctx}  id "${id}" ${where} non-numeric coordinate at index ${k}`);
        return;
      }
      if (Math.abs(v) > 1000) {
        issues.push(`${ctx}  id "${id}" ${where} coordinate ${v} looks like millimeters — must be in meters`);
        return;
      }
    }
    if (isSpatial && p.length !== 3) {
      issues.push(`${ctx}  id "${id}" ${where} spatial element requires 3D coordinates [x,y,z]`);
    }
    if (!isSpatial && p.length === 3) {
      issues.push(`${ctx}  id "${id}" ${where} level-anchored element should use 2D coordinates (Z lives in base_offset/top_offset properties)`);
    }
  };

  if (g.type === 'Point') {
    checkPosition(g.coordinates, 'Point');
  } else if (g.type === 'LineString') {
    if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) {
      issues.push(`${ctx}  id "${id}" LineString needs at least 2 coordinates`);
    } else {
      checkPosition(g.coordinates[0], 'LineString[0]');
      checkPosition(g.coordinates[g.coordinates.length - 1], 'LineString[last]');
    }
  } else if (g.type === 'Polygon') {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) {
      issues.push(`${ctx}  id "${id}" Polygon needs at least one ring`);
    } else {
      const ring = g.coordinates[0];
      if (!Array.isArray(ring) || ring.length < 4) {
        issues.push(`${ctx}  id "${id}" Polygon outer ring needs >= 4 positions (including closing duplicate)`);
      } else {
        checkPosition(ring[0], 'Polygon outer[0]');
        const first = ring[0], last = ring[ring.length - 1];
        if (Array.isArray(first) && Array.isArray(last)) {
          if (first[0] !== last[0] || first[1] !== last[1]) {
            issues.push(`${ctx}  id "${id}" Polygon outer ring not closed (first ≠ last)`);
          }
        }
      }
    }
  }

  return issues;
}
