import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement } from './elements.ts';
import { computeBounds } from './elements.ts';
import type { CsvRow } from '../types.ts';
import { csvHeadersForTable } from './tableRegistry.ts';
import { SPEC_COLUMNS } from './specColumns.generated.ts';
import { stripTypeAttrs, type TypeCatalog } from './types/catalog.ts';

/** Tables that are CSV-only (no SVG geometry file). */
const CSV_ONLY_TABLES = new Set(['door', 'window', 'space', 'connector']);

/**
 * Group elements by discipline/tableName key.
 */
export function groupByLayer(elements: CanonicalElement[]): Map<string, CanonicalElement[]> {
  const groups = new Map<string, CanonicalElement[]>();
  for (const el of elements) {
    const key = `${el.discipline}/${el.tableName}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(el);
  }
  return groups;
}

/**
 * Check if a table is CSV-only (no SVG file).
 * Opening is dual-mode: returns false so SVG is checked per-element.
 */
export function isCsvOnlyTable(tableName: string): boolean {
  return CSV_ONLY_TABLES.has(tableName);
}

/** Tables that support dual mode (some elements have SVG, some don't). */
const DUAL_MODE_TABLES = new Set(['opening']);

/**
 * Serialize elements of one layer to canonical SVG string.
 * Returns empty string for CSV-only tables (no SVG needed).
 */
export function serializeToSvg(elements: CanonicalElement[]): string {
  if (elements.length === 0) return '';

  // CSV-only tables don't have SVG
  const tableName = elements[0].tableName;
  if (CSV_ONLY_TABLES.has(tableName)) return '';

  // Dual-mode tables: only serialize SVG for polygon elements (slab openings)
  if (DUAL_MODE_TABLES.has(tableName)) {
    const svgElements = elements.filter(el => el.geometry === 'polygon');
    if (svgElements.length === 0) return '';
    // Recurse with only polygon elements to generate their SVG
    elements = svgElements;
  }

  const bounds = computeBounds(elements);
  const vb = bounds ? `${r(bounds.x)} ${r(bounds.y)} ${r(bounds.w)} ${r(bounds.h)}` : '0 0 100 100';

  const innerElements: string[] = [];

  for (const el of elements) {
    switch (el.geometry) {
      case 'line':
        innerElements.push(serializeLine(el));
        break;
      case 'spatial_line':
        innerElements.push(serializeSpatialLine(el));
        break;
      case 'point':
        innerElements.push(serializePoint(el));
        break;
      case 'polygon':
        innerElements.push(serializePolygon(el));
        break;
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">\n  <g transform="scale(1,-1)">\n${innerElements.map(s => '    ' + s).join('\n')}\n  </g>\n</svg>`;
}

function serializePathD(start: { x: number; y: number }, end: { x: number; y: number }, arc?: import('../geometry/arc.ts').ArcParams): string {
  if (arc) {
    return `M ${r(start.x)},${r(start.y)} A ${r(arc.rx)},${r(arc.ry)} ${r(arc.rotation)} ${arc.largeArc ? 1 : 0} ${arc.sweep ? 1 : 0} ${r(end.x)},${r(end.y)}`;
  }
  return `M ${r(start.x)},${r(start.y)} L ${r(end.x)},${r(end.y)}`;
}

function serializeLine(el: LineElement): string {
  return `<path id="${el.id}" d="${serializePathD(el.start, el.end, el.arc)}" />`;
}

function serializeSpatialLine(el: SpatialLineElement): string {
  return `<path id="${el.id}" d="${serializePathD(el.start, el.end, el.arc)}" />`;
}

function serializePoint(el: PointElement): string {
  if (el.width === el.height) {
    // Circular: use <circle>
    const radius = el.width / 2;
    return `<circle id="${el.id}" cx="${r(el.position.x)}" cy="${r(el.position.y)}" r="${r(radius)}" />`;
  }
  const x = el.position.x - el.width / 2;
  const y = el.position.y - el.height / 2;
  return `<rect id="${el.id}" x="${r(x)}" y="${r(y)}" width="${r(el.width)}" height="${r(el.height)}" />`;
}

function serializePolygon(el: PolygonElement): string {
  const points = el.vertices.map(v => `${r(v.x)},${r(v.y)}`).join(' ');
  return `<polygon id="${el.id}" points="${points}" />`;
}

/** Round to 3 decimal places */
function r(n: number): string {
  return Number(n.toFixed(3)).toString();
}

// ─── GeoJSON output (storage format) ──────────────────────

const SPATIAL_3D_TABLES = new Set([
  'stair', 'ramp', 'railing',
  'beam', 'brace',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
]);

interface GeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: 'Point'; coordinates: number[] } | { type: 'LineString'; coordinates: number[][] } | { type: 'Polygon'; coordinates: number[][][] };
}

/** Spatial point tables: Z goes into the 3D coordinate, not a base_offset. */
const SPATIAL_POINT_TABLES = new Set(['equipment', 'terminal', 'mep_node']);

/**
 * Serialize a list of elements (single layer) as a BimDown GeoJSON FeatureCollection string.
 * Returns empty string for CSV-only tables. For dual-mode tables (opening), only polygon
 * elements are emitted.
 *
 * `elevation` converts the editor's level-relative spatial Z back to the spec's
 * absolute Z (pass the level elevation when writing files; 0 for in-memory
 * layers and global/, which stay in editor form).
 */
export function serializeToGeoJson(elements: CanonicalElement[], elevation = 0): string {
  if (elements.length === 0) return '';

  const tableName = elements[0].tableName;
  if (CSV_ONLY_TABLES.has(tableName)) return '';
  if (DUAL_MODE_TABLES.has(tableName)) {
    elements = elements.filter(el => el.geometry === 'polygon');
    if (elements.length === 0) return '';
  }

  const isSpatial = SPATIAL_3D_TABLES.has(tableName);
  const features: GeoJsonFeature[] = [];

  for (const el of elements) {
    const feat = featureForElement(el, isSpatial, elevation);
    if (feat) features.push(feat);
  }

  return stringifyFc(features);
}

function featureForElement(el: CanonicalElement, isSpatial: boolean, elevation: number): GeoJsonFeature | null {
  switch (el.geometry) {
    case 'line': {
      const line = el as LineElement;
      const props: Record<string, unknown> = { id: line.id };
      if (line.arc) {
        // Editor uses {rx, ry, rotation, largeArc, sweep}; spec uses {radius, large_arc, sweep}.
        // Emit canonical spec form (radius = average of rx/ry).
        props.arc = {
          radius: Number(((line.arc.rx + line.arc.ry) / 2).toFixed(3)),
          large_arc: line.arc.largeArc === true,
          sweep: line.arc.sweep === true,
        };
      }
      attachZProps(props, line.attrs);
      return {
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'LineString',
          coordinates: [[r2(line.start.x), r2(line.start.y)], [r2(line.end.x), r2(line.end.y)]],
        },
      };
    }
    case 'spatial_line': {
      const line = el as SpatialLineElement;
      const props: Record<string, unknown> = { id: line.id };
      if (line.arc) {
        props.arc = {
          radius: Number(((line.arc.rx + line.arc.ry) / 2).toFixed(3)),
          large_arc: line.arc.largeArc === true,
          sweep: line.arc.sweep === true,
        };
      }
      // Vertical-span offsets (stair top_offset, …) are GeoJSON properties too.
      attachZProps(props, line.attrs);
      return {
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'LineString',
          coordinates: [
            [r2(line.start.x), r2(line.start.y), r2(line.startZ + elevation)],
            [r2(line.end.x), r2(line.end.y), r2(line.endZ + elevation)],
          ],
        },
      };
    }
    case 'point': {
      const pt = el as PointElement;
      const props: Record<string, unknown> = { id: pt.id };
      const rot = parseFloat(pt.attrs.rotation ?? '');
      if (!isNaN(rot) && rot !== 0) props.rotation = rot;
      let coords: number[];
      if (isSpatial) {
        // Spatial point (equipment/terminal/mep_node): absolute Z in the coordinate.
        const rel = parseFloat(pt.attrs.base_offset ?? '') || 0;
        coords = [r2(pt.position.x), r2(pt.position.y), r2(rel + elevation)];
      } else {
        attachZProps(props, pt.attrs);
        coords = [r2(pt.position.x), r2(pt.position.y)];
      }
      // Tables without CSV size columns (equipment, terminal, mep_node) keep
      // their bounding box in `properties.size = [x, y, z]` (spec element.yaml).
      const spec = SPEC_COLUMNS[pt.tableName];
      if (spec && !spec.csv.includes('size_x') && pt.width > 0 && pt.height > 0) {
        const size = [r2(pt.width), r2(pt.height)];
        const z = parseFloat(pt.attrs.height ?? '');
        if (isFinite(z) && z > 0) size.push(r2(z));
        props.size = size;
      }
      return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coords } };
    }
    case 'polygon': {
      const poly = el as PolygonElement;
      if (poly.vertices.length < 3) return null;
      const ring: number[][] = poly.vertices.map(v => [r2(v.x), r2(v.y)]);
      // Close the ring per RFC 7946
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
      const props: Record<string, unknown> = { id: poly.id };
      attachZProps(props, poly.attrs);
      return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
    }
  }
  return null;
}

function attachZProps(props: Record<string, unknown>, attrs: Record<string, string>): void {
  const base = parseFloat(attrs.base_offset ?? '');
  if (!isNaN(base) && base !== 0) props.base_offset = base;
  const top = parseFloat(attrs.top_offset ?? '');
  if (!isNaN(top) && top !== 0) props.top_offset = top;
  const heightOffset = parseFloat(attrs.height_offset ?? '');
  if (!isNaN(heightOffset)) props.height_offset = heightOffset;
}

function stringifyFc(features: GeoJsonFeature[]): string {
  const lines: string[] = ['{', '  "type": "FeatureCollection",', '  "features": ['];
  for (let i = 0; i < features.length; i++) {
    const sep = i === features.length - 1 ? '' : ',';
    lines.push('    ' + JSON.stringify(features[i]) + sep);
  }
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

function r2(n: number): number {
  if (!isFinite(n)) return 0;
  return Number(n.toFixed(3));
}

/**
 * Serialize elements of one layer to CSV string.
 */
export function serializeToCsv(elements: CanonicalElement[], tableName: string, types?: TypeCatalog): string {
  if (elements.length === 0) return '';
  // Typed elements hold effective values in memory; on disk a value equal to
  // the type's stays empty so later type edits reach the element.
  if (types && types.types.length > 0) {
    elements = elements.map(el => {
      const attrs = stripTypeAttrs(tableName, el.attrs, types);
      return attrs === el.attrs ? el : { ...el, attrs };
    });
  }

  // Collect all attribute keys (preserve order from first element, then add any extras)
  const headerSet = new Set<string>();
  const csvHeaders = getCsvHeaders(tableName);
  for (const h of csvHeaders) headerSet.add(h);
  for (const el of elements) {
    for (const k of Object.keys(el.attrs)) {
      headerSet.add(k);
    }
  }
  // `id` is always the first column (attrs may carry it too).
  headerSet.delete('id');

  const spec = SPEC_COLUMNS[tableName];
  if (spec) {
    // Only the spec's CSV columns. Everything else the editor keeps in attrs
    // lives elsewhere (Z offsets / rotation / size in GeoJSON properties,
    // spatial Z in coordinates) or is computed (start_z, height, …).
    const allowed = new Set(spec.csv);
    for (const h of headerSet) if (!allowed.has(h)) headerSet.delete(h);
  } else {
    // Tables unknown to the spec: drop what is known to be computed.
    if (SPATIAL_3D_TABLES.has(tableName)) {
      headerSet.delete('start_z');
      headerSet.delete('end_z');
    }
    if (SPATIAL_POINT_TABLES.has(tableName)) headerSet.delete('base_offset');
  }

  const headers = ['id', ...headerSet];
  const lines: string[] = [headers.join(',')];

  for (const el of elements) {
    const values = headers.map(h => {
      if (h === 'id') return el.id;
      const v = el.attrs[h] ?? '';
      // Quote if contains comma or quote
      if (v.includes(',') || v.includes('"')) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    });
    lines.push(values.join(','));
  }

  return lines.join('\n');
}

function getCsvHeaders(tableName: string): string[] {
  return csvHeadersForTable(tableName);
}

/**
 * Convert elements to CsvRow map (for processor.ts compatibility).
 */
export function elementsToCsvRows(elements: CanonicalElement[]): Map<string, CsvRow> {
  const map = new Map<string, CsvRow>();
  for (const el of elements) {
    map.set(el.id, { id: el.id, ...el.attrs });
  }
  return map;
}
