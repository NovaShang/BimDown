/**
 * GeoJSON file I/O for BimDown geometry files; types and helpers live in
 * geojson-core.ts (no file access).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGeoJsonText, stringifyFeatureCollection, type BimDownFeatureCollection } from './geojson-core.js';

export * from './geojson-core.js';

export function parseGeoJsonFile(filePath: string): BimDownFeatureCollection {
  return parseGeoJsonText(readFileSync(filePath, 'utf-8'), filePath);
}

export function writeGeoJsonFile(filePath: string, fc: BimDownFeatureCollection): void {
  const json = stringifyFeatureCollection(fc);
  writeFileSync(filePath, json, 'utf-8');
}
