/**
 * bimdown-cli library entry — for programmatic use by AI agents and scripts.
 *
 * Usage:
 *   import {
 *     readBimDownGeometry, writeBimDownGeometry,
 *     readFeatureCollection, writeFeatureCollection,
 *     geoJsonToJsts, jstsToGeoJson,
 *     GeometryFactory, Coordinate,
 *   } from 'bimdown-cli';
 */

export {
  readBimDownGeometry,
  writeBimDownGeometry,
  readFeatureCollection,
  writeFeatureCollection,
  geoJsonToJsts,
  jstsToGeoJson,
  type BimDownGeometry,
  type GeometryMap,
} from './geo/index.js';

// Re-export JSTS classes so consumers don't need a separate jsts dependency
export {
  Coordinate,
  GeometryFactory,
} from './geo/jsts-exports.js';

// Low-level GeoJSON parsing utilities
export {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  extractLineGeometry,
  extractPointGeometry,
  extractPolygonGeometry,
  geometryBounds,
  featureId,
  type BimDownFeature,
  type BimDownFeatureCollection,
  type BimDownFeatureProperties,
  type GeoJsonGeometry,
  type PointGeometryJson,
  type LineStringGeometryJson,
  type PolygonGeometryJson,
  type Position,
  type ArcParams,
  type LineGeometry,
  type PointGeometry,
  type PolygonGeometry,
} from './utils/geojson.js';

// Element types: load a project's catalog, resolve effective params and layers
export {
  loadCatalog,
  catalogFromRows,
  effectiveRow,
  effectiveRows,
  resolvedLayers,
  projectElementLayers,
  typeValues,
  typeParamFields,
  layerTotal,
  type TypeCatalog,
  type ElementType,
  type TypeLayer,
  type ResolvedLayer,
  type ElementLayers,
} from './catalog/index.js';
