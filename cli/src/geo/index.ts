/**
 * BimDown geometry toolkit — bridges GeoJSON files and JSTS computational geometry.
 *
 * AI agents and scripts can use this to:
 *   - Load all geometry from a BimDown GeoJSON file as JSTS geometries
 *   - Perform computational geometry operations (buffer, split, boolean ops)
 *   - Write results back to GeoJSON files
 *
 * Example:
 *   import { readBimDownGeometry, writeBimDownGeometry, GeometryFactory, Coordinate } from 'bimdown-cli';
 *
 *   const slabs = readBimDownGeometry('project/lv-1/slab.geojson');
 *   const slab = slabs.get('sl-1');                              // JSTS Polygon
 *
 *   const factory = new GeometryFactory();
 *   const splitLine = factory.createPolygon(factory.createLinearRing([
 *     new Coordinate(-1000, -1000), new Coordinate(5, -1000),
 *     new Coordinate(5, 1000), new Coordinate(-1000, 1000),
 *     new Coordinate(-1000, -1000),
 *   ]));
 *   const left = slab.intersection(splitLine);
 *   const right = slab.difference(splitLine);
 *
 *   slabs.delete('sl-1');
 *   slabs.set('sl-1a', left);
 *   slabs.set('sl-1b', right);
 *   writeBimDownGeometry('project/lv-1/slab.geojson', slabs);
 */
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  type BimDownFeature,
  type BimDownFeatureCollection,
  type GeoJsonGeometry,
  type Position,
} from '../utils/geojson.js';
import { writeFileSync } from 'node:fs';
import { Coordinate, GeometryFactory } from './jsts-exports.js';

export interface JstsGeometry {
  getGeometryType(): 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'GeometryCollection' | (string & {});
  getCoordinates(): { x: number; y: number; z?: number }[];
  getCoordinate(): { x: number; y: number; z?: number };
  getEnvelopeInternal(): {
    getMinX(): number;
    getMinY(): number;
    getMaxX(): number;
    getMaxY(): number;
  };
  getNumGeometries(): number;
  getGeometryN(i: number): JstsGeometry;
  getExteriorRing(): JstsGeometry;
  intersection(other: JstsGeometry): JstsGeometry;
  union(other: JstsGeometry): JstsGeometry;
  difference(other: JstsGeometry): JstsGeometry;
  symDifference(other: JstsGeometry): JstsGeometry;
  buffer(distance: number): JstsGeometry;
  contains(other: JstsGeometry): boolean;
  intersects(other: JstsGeometry): boolean;
  isEmpty(): boolean;
}

export type BimDownGeometry = JstsGeometry;
export type GeometryMap = Map<string, BimDownGeometry>;

const factory = new GeometryFactory();

/**
 * Convert a GeoJSON geometry to a JSTS geometry.
 * Returns null for unsupported types.
 */
export function geoJsonToJsts(g: GeoJsonGeometry): BimDownGeometry | null {
  switch (g.type) {
    case 'Point': {
      const c = g.coordinates;
      return factory.createPoint(new Coordinate(c[0], c[1]));
    }
    case 'LineString': {
      const coords = g.coordinates.map((p) => new Coordinate(p[0], p[1]));
      return factory.createLineString(coords);
    }
    case 'Polygon': {
      const [outer, ...holes] = g.coordinates;
      if (!outer || outer.length < 4) return null;
      const outerRing = factory.createLinearRing(outer.map((p) => new Coordinate(p[0], p[1])));
      if (holes.length === 0) return factory.createPolygon(outerRing);
      const holeRings = holes.map((h) => factory.createLinearRing(h.map((p) => new Coordinate(p[0], p[1]))));
      return factory.createPolygon(outerRing, holeRings);
    }
  }
  return null;
}

/**
 * Convert a JSTS geometry back to a GeoJSON geometry.
 * Multi* geometries are returned as their first sub-geometry; callers needing
 * a split into multiple Features should use `writeBimDownGeometry`, which handles it.
 */
export function jstsToGeoJson(geom: BimDownGeometry): GeoJsonGeometry | null {
  const type = geom.getGeometryType();
  switch (type) {
    case 'Point': {
      const c = geom.getCoordinate();
      return { type: 'Point', coordinates: [round(c.x), round(c.y)] };
    }
    case 'LineString': {
      const coords = geom.getCoordinates().map((c) => [round(c.x), round(c.y)] as Position);
      return { type: 'LineString', coordinates: coords };
    }
    case 'Polygon': {
      const ring = geom.getExteriorRing();
      const coords = ring.getCoordinates().map((c) => [round(c.x), round(c.y)] as Position);
      return { type: 'Polygon', coordinates: [coords] };
    }
  }
  return null;
}

/**
 * Read a BimDown GeoJSON file and return a Map of element id → JSTS geometry.
 *
 * Geometry property metadata (arc, rotation, base_offset, …) is dropped on this
 * conversion. For round-trip fidelity with metadata, use `readFeatureCollection`
 * and write back via `writeFeatureCollection`.
 */
export function readBimDownGeometry(filePath: string): GeometryMap {
  const fc = parseGeoJsonFile(filePath);
  const map: GeometryMap = new Map();
  for (const f of fc.features) {
    const id = f.properties?.id;
    if (typeof id !== 'string' || !id) continue;
    const jsts = geoJsonToJsts(f.geometry);
    if (jsts) map.set(id, jsts);
  }
  return map;
}

/**
 * Write a GeometryMap back as a BimDown FeatureCollection.
 * Multi* JSTS results are split into multiple Features with suffixed ids (`<id>a`, `<id>b`, …).
 */
export function writeBimDownGeometry(filePath: string, geometries: GeometryMap): void {
  const features: BimDownFeature[] = [];
  for (const [id, geom] of geometries) {
    const n = typeof geom.getNumGeometries === 'function' ? geom.getNumGeometries() : 1;
    const isMulti = n > 1 && /^Multi/.test(geom.getGeometryType());
    if (!isMulti) {
      const g = jstsToGeoJson(geom);
      if (g) features.push({ type: 'Feature', properties: { id }, geometry: g });
      continue;
    }
    for (let i = 0; i < n; i++) {
      const sub = geom.getGeometryN(i);
      const g = jstsToGeoJson(sub);
      if (g) features.push({ type: 'Feature', properties: { id: `${id}${String.fromCharCode(97 + i)}` }, geometry: g });
    }
  }
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  writeFileSync(filePath, stringifyFeatureCollection(fc), 'utf-8');
}

/** Read a BimDown FeatureCollection preserving all properties. */
export function readFeatureCollection(filePath: string): BimDownFeatureCollection {
  return parseGeoJsonFile(filePath);
}

/** Write a BimDown FeatureCollection (compact one-line-per-feature formatting). */
export function writeFeatureCollection(filePath: string, fc: BimDownFeatureCollection): void {
  writeFileSync(filePath, stringifyFeatureCollection(fc), 'utf-8');
}

function round(n: number): number {
  if (!isFinite(n)) return 0;
  return Number(n.toFixed(3));
}
