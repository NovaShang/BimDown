/**
 * GeoJSON I/O for BimDown geometry files.
 *
 * BimDown uses a strict subset of GeoJSON (see spec/geojson-schema/readme.md):
 *   - FeatureCollection at the top level
 *   - Per Feature: properties.id (matches CSV row) + geometry (Point, LineString, or Polygon)
 *   - 2D coords [x, y] for level-anchored elements (walls, slabs, columns, ...)
 *   - 3D coords [x, y, z] for spatial elements (beams, ducts, ...)
 *
 * Optional properties carry numeric geometry hints:
 *   - base_offset, top_offset (meters): Z offsets for level-anchored elements
 *   - arc: { radius, large_arc, sweep } for curved LineStrings
 *   - rotation (degrees CCW about +Z) for Point elements
 */
import { readFileSync, writeFileSync } from 'node:fs';

export type Position = [number, number] | [number, number, number];

export interface PointGeometryJson {
  type: 'Point';
  coordinates: Position;
}

export interface LineStringGeometryJson {
  type: 'LineString';
  coordinates: Position[];
}

export interface PolygonGeometryJson {
  type: 'Polygon';
  /** First ring is the outer ring; subsequent rings are holes. */
  coordinates: Position[][];
}

export type GeoJsonGeometry = PointGeometryJson | LineStringGeometryJson | PolygonGeometryJson;

export interface ArcParams {
  radius: number;
  large_arc: boolean;
  sweep: boolean;
}

export interface BimDownFeatureProperties {
  id: string;
  base_offset?: number;
  top_offset?: number;
  arc?: ArcParams;
  rotation?: number;
  /** Any additional AI-emitted hints — preserved on round-trip until normalized away. */
  [key: string]: unknown;
}

export interface BimDownFeature {
  type: 'Feature';
  properties: BimDownFeatureProperties;
  geometry: GeoJsonGeometry;
}

export interface BimDownFeatureCollection {
  type: 'FeatureCollection';
  features: BimDownFeature[];
}

// ─── Parsing ──────────────────────────────────────────────

export function parseGeoJsonFile(filePath: string): BimDownFeatureCollection {
  let text = readFileSync(filePath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Failed to parse GeoJSON at ${filePath}: ${e.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || (parsed as any).type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection at ${filePath}, got ${(parsed as any)?.type ?? typeof parsed}`);
  }

  const fc = parsed as BimDownFeatureCollection;
  if (!Array.isArray(fc.features)) {
    throw new Error(`FeatureCollection at ${filePath} has no features array`);
  }

  return fc;
}

// ─── Serialization ────────────────────────────────────────

export function writeGeoJsonFile(filePath: string, fc: BimDownFeatureCollection): void {
  const json = stringifyFeatureCollection(fc);
  writeFileSync(filePath, json, 'utf-8');
}

/**
 * Pretty-print a FeatureCollection with one feature per line (compact coords)
 * for human readability and clean diffs.
 */
export function stringifyFeatureCollection(fc: BimDownFeatureCollection): string {
  const lines: string[] = ['{', '  "type": "FeatureCollection",', '  "features": ['];
  for (let i = 0; i < fc.features.length; i++) {
    const sep = i === fc.features.length - 1 ? '' : ',';
    lines.push('    ' + JSON.stringify(fc.features[i]) + sep);
  }
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

// ─── Geometry extraction (used by hydrate & validate) ─────

export interface LineGeometry {
  start_x: number;
  start_y: number;
  start_z?: number;
  end_x: number;
  end_y: number;
  end_z?: number;
  length: number;
  arc?: ArcParams;
}

export interface PointGeometry {
  x: number;
  y: number;
  z?: number;
  rotation: number;
}

export interface PolygonGeometry {
  /** Outer ring, 2D, with closing duplicate vertex removed. */
  outer: { x: number; y: number }[];
  /** Holes, each ring same convention as outer. */
  holes: { x: number; y: number }[][];
  /** Signed area of the outer ring minus holes (always returned as absolute m²). */
  area: number;
}

export function extractLineGeometry(feature: BimDownFeature): LineGeometry {
  const g = feature.geometry;
  if (g.type !== 'LineString') {
    throw new Error(`Feature ${featureId(feature)} expected LineString, got ${g.type}`);
  }
  const coords = g.coordinates;
  if (coords.length < 2) {
    throw new Error(`Feature ${featureId(feature)} LineString has fewer than 2 coordinates`);
  }
  // Canonical form is 2 coords; if more, use first and last.
  const first = coords[0];
  const last = coords[coords.length - 1];
  const out: LineGeometry = {
    start_x: first[0],
    start_y: first[1],
    end_x: last[0],
    end_y: last[1],
    length: 0,
  };
  if (first.length === 3) out.start_z = first[2];
  if (last.length === 3) out.end_z = last[2];

  const arc = feature.properties.arc;
  if (arc) {
    out.arc = arc;
    out.length = arcLength(first[0], first[1], last[0], last[1], arc);
  } else {
    const dx = last[0] - first[0];
    const dy = last[1] - first[1];
    const dz = (last[2] ?? 0) - (first[2] ?? 0);
    out.length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return out;
}

export function extractPointGeometry(feature: BimDownFeature): PointGeometry {
  const g = feature.geometry;
  if (g.type !== 'Point') {
    throw new Error(`Feature ${featureId(feature)} expected Point, got ${g.type}`);
  }
  const c = g.coordinates;
  return {
    x: c[0],
    y: c[1],
    z: c.length === 3 ? c[2] : undefined,
    rotation: typeof feature.properties.rotation === 'number' ? feature.properties.rotation : 0,
  };
}

export function extractPolygonGeometry(feature: BimDownFeature): PolygonGeometry {
  const g = feature.geometry;
  if (g.type !== 'Polygon') {
    throw new Error(`Feature ${featureId(feature)} expected Polygon, got ${g.type}`);
  }
  const rings = g.coordinates;
  if (rings.length === 0) {
    return { outer: [], holes: [], area: 0 };
  }
  const outer = ringTo2D(rings[0]);
  const holes = rings.slice(1).map(ringTo2D);
  let area = Math.abs(shoelace(outer));
  for (const h of holes) {
    area -= Math.abs(shoelace(h));
  }
  return { outer, holes, area: Math.max(0, area) };
}

function ringTo2D(ring: Position[]): { x: number; y: number }[] {
  // Drop the closing duplicate vertex if present.
  let end = ring.length;
  if (end >= 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) end -= 1;
  }
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < end; i++) {
    out.push({ x: ring[i][0], y: ring[i][1] });
  }
  return out;
}

function shoelace(ring: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
}

/**
 * Length of an SVG-style arc from (x1,y1) to (x2,y2) with radius r and flags.
 * Used for hydrating `length` on curved walls/ramps.
 */
export function arcLength(x1: number, y1: number, x2: number, y2: number, arc: ArcParams): number {
  const r = Math.abs(arc.radius);
  if (r === 0) return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const chord = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const half = Math.min(1, chord / (2 * r));
  const sweepAngle = arc.large_arc ? 2 * Math.PI - 2 * Math.asin(half) : 2 * Math.asin(half);
  return r * sweepAngle;
}

// ─── Helpers ──────────────────────────────────────────────

export function featureId(feature: BimDownFeature): string {
  const id = feature.properties?.id;
  return typeof id === 'string' ? id : '<unknown>';
}

/**
 * Compute axis-aligned bounding box of a geometry. Returns null for empty.
 * Z is included only if all coordinates carry Z.
 */
export function geometryBounds(g: GeoJsonGeometry):
  | { minX: number; minY: number; maxX: number; maxY: number; minZ?: number; maxZ?: number }
  | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let allHaveZ = true;
  let anyCoord = false;

  const visit = (p: Position) => {
    anyCoord = true;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p.length === 3) {
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    } else {
      allHaveZ = false;
    }
  };

  if (g.type === 'Point') visit(g.coordinates);
  else if (g.type === 'LineString') for (const p of g.coordinates) visit(p);
  else if (g.type === 'Polygon') for (const ring of g.coordinates) for (const p of ring) visit(p);

  if (!anyCoord) return null;
  const out: { minX: number; minY: number; maxX: number; maxY: number; minZ?: number; maxZ?: number } = {
    minX, minY, maxX, maxY,
  };
  if (allHaveZ) { out.minZ = minZ; out.maxZ = maxZ; }
  return out;
}
