import type { LayerData, CsvRow } from '../types.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement, Point } from './elements.ts';
import { geometryTypeForTable, isHostedTable } from './elements.ts';
import { resolveHostedGeometry } from './hosted.ts';

const parser = new DOMParser();

/** Tables that are CSV-only (no SVG geometry file). */
const CSV_ONLY_TABLES = new Set(['door', 'window', 'space']);

/** Tables with mixed geometry (different SVG element types in the same layer). */
const MIXED_GEOMETRY_TABLES = new Set(['foundation']);

/**
 * Tables that support dual mode: some elements are CSV-only (wall-hosted),
 * others have SVG geometry (slab-hosted). Parsed per-element based on SVG presence.
 */
const DUAL_MODE_TABLES = new Set(['opening']);

/**
 * Parse a LayerData (raw SVG + CSV) into CanonicalElement[].
 */
export function parseLayer(layer: LayerData): CanonicalElement[] {
  const geoType = geometryTypeForTable(layer.tableName);
  if (!geoType) return [];

  // CSV-only tables: parse directly from CSV rows
  if (CSV_ONLY_TABLES.has(layer.tableName)) {
    return parseCsvOnlyLayer({ ...layer, csvRows: validateCsvRows(layer.csvRows, layer.tableName) });
  }

  // Mixed-geometry tables: parse all element types from SVG
  if (MIXED_GEOMETRY_TABLES.has(layer.tableName)) {
    return parseMixedGeometryLayer(layer);
  }

  // Dual-mode tables (opening): some elements have SVG (slab openings), others are CSV-only (wall openings)
  if (DUAL_MODE_TABLES.has(layer.tableName)) {
    return parseDualModeLayer(layer);
  }

  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);

  const doc = parser.parseFromString(layer.svgContent, 'image/svg+xml');
  const g = doc.querySelector('g');
  if (!g) return [];

  const elements: CanonicalElement[] = [];

  const hosted = isHostedTable(layer.tableName);

  switch (geoType) {
    case 'line':
    case 'spatial_line': {
      const paths = g.querySelectorAll('path');
      for (const path of paths) {
        const id = path.getAttribute('id') || '';
        if (!id) continue;
        const csv = csvRows.get(id);
        const el = geoType === 'spatial_line'
          ? parseSpatialLineFromPath(id, path, layer, csv)
          : parseLineFromPath(id, path, layer, csv);
        if (hosted) applyHostFields(el, csv);
        elements.push(el);
      }
      break;
    }
    case 'point': {
      const rects = g.querySelectorAll('rect');
      for (const rect of rects) {
        const id = rect.getAttribute('id') || '';
        if (!id) continue;
        const csv = csvRows.get(id);
        const el = parsePointElement(id, rect, layer, csv);
        if (hosted) applyHostFields(el, csv);
        elements.push(el);
      }
      const circles = g.querySelectorAll('circle');
      for (const circle of circles) {
        const id = circle.getAttribute('id') || '';
        if (!id) continue;
        const csv = csvRows.get(id);
        const el = parsePointFromCircle(id, circle, layer, csv);
        if (hosted) applyHostFields(el, csv);
        elements.push(el);
      }
      break;
    }
    case 'polygon': {
      const polys = g.querySelectorAll('polygon');
      for (const poly of polys) {
        const id = poly.getAttribute('id') || '';
        if (!id) continue;
        const csv = csvRows.get(id);
        const el = parsePolygonElement(id, poly, layer, csv);
        if (hosted) applyHostFields(el, csv);
        elements.push(el);
      }
      break;
    }
  }

  return elements;
}

/**
 * Parse a mixed-geometry layer (e.g. foundation) where elements may be
 * <rect>/<circle> (point), <path> (line), or <polygon> depending on subtype.
 */
function parseMixedGeometryLayer(layer: LayerData): CanonicalElement[] {
  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);
  const doc = parser.parseFromString(layer.svgContent, 'image/svg+xml');
  const g = doc.querySelector('g');
  if (!g) return [];

  const elements: CanonicalElement[] = [];

  // Point-like foundations (isolated): <rect> and <circle>
  const rects = g.querySelectorAll('rect');
  for (const rect of rects) {
    const id = rect.getAttribute('id') || '';
    if (!id) continue;
    elements.push(parsePointElement(id, rect, layer, csvRows.get(id)));
  }
  const circles = g.querySelectorAll('circle');
  for (const circle of circles) {
    const id = circle.getAttribute('id') || '';
    if (!id) continue;
    elements.push(parsePointFromCircle(id, circle, layer, csvRows.get(id)));
  }

  // Line-like foundations (strip): <path>
  const paths = g.querySelectorAll('path');
  for (const path of paths) {
    const id = path.getAttribute('id') || '';
    if (!id) continue;
    elements.push(parseLineFromPath(id, path, layer, csvRows.get(id)));
  }

  // Polygon-like foundations (raft): <polygon>
  const polys = g.querySelectorAll('polygon');
  for (const poly of polys) {
    const id = poly.getAttribute('id') || '';
    if (!id) continue;
    elements.push(parsePolygonElement(id, poly, layer, csvRows.get(id)));
  }

  return elements;
}

/**
 * Parse a dual-mode layer (opening): elements with SVG geometry are slab openings
 * (parsed as polygons from <rect>/<polygon>), elements without SVG are wall openings
 * (parsed as CSV-only hosted lines).
 */
function parseDualModeLayer(layer: LayerData): CanonicalElement[] {
  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);
  const elements: CanonicalElement[] = [];

  // Track which IDs have SVG geometry
  const svgIds = new Set<string>();

  // Parse SVG geometry if present (slab openings)
  if (layer.svgContent) {
    const doc = parser.parseFromString(layer.svgContent, 'image/svg+xml');
    const g = doc.querySelector('g');
    if (g) {
      // <rect> elements → polygon (4-vertex rectangle)
      const rects = g.querySelectorAll('rect');
      for (const rect of rects) {
        const id = rect.getAttribute('id') || '';
        if (!id) continue;
        svgIds.add(id);
        const csv = csvRows.get(id);
        const x = parseFloat(rect.getAttribute('x') || '0');
        const y = parseFloat(rect.getAttribute('y') || '0');
        const w = parseFloat(rect.getAttribute('width') || '0');
        const h = parseFloat(rect.getAttribute('height') || '0');
        const el: PolygonElement = {
          geometry: 'polygon',
          id,
          tableName: layer.tableName,
          discipline: layer.discipline,
          vertices: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ],
          attrs: csvToAttrs(csv, id),
        };
        if (csv?.host_id) el.hostId = csv.host_id;
        elements.push(el);
      }

      // <polygon> elements → polygon
      const polys = g.querySelectorAll('polygon');
      for (const poly of polys) {
        const id = poly.getAttribute('id') || '';
        if (!id) continue;
        svgIds.add(id);
        const csv = csvRows.get(id);
        const el = parsePolygonElement(id, poly, layer, csv);
        if (csv?.host_id) el.hostId = csv.host_id;
        elements.push(el);
      }
    }
  }

  // Remaining CSV rows without SVG → wall openings (CSV-only hosted lines)
  for (const [id, csv] of csvRows) {
    if (svgIds.has(id)) continue;
    const attrs = csvToAttrs(csv, id);
    const el: LineElement = {
      geometry: 'line',
      id,
      tableName: layer.tableName,
      discipline: layer.discipline,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      strokeWidth: 0.08,
      attrs,
    };
    el.hostId = csv.host_id ?? '';
    el.locationParam = parseFloat(csv.position ?? '0.5');
    elements.push(el);
  }

  return elements;
}

/**
 * Parse CSV-only layer (door, window, space) — no SVG geometry.
 */
function parseCsvOnlyLayer(layer: LayerData): CanonicalElement[] {
  const elements: CanonicalElement[] = [];

  for (const [id, csv] of layer.csvRows) {
    if (!id) continue;
    const attrs = csvToAttrs(csv, id);

    if (layer.tableName === 'space') {
      // Space: point from CSV x, y
      const el: PointElement = {
        geometry: 'point',
        id,
        tableName: layer.tableName,
        discipline: layer.discipline,
        position: {
          x: parseFloat(csv.x ?? '0'),
          y: parseFloat(csv.y ?? '0'),
        },
        width: 0.3,
        height: 0.3,
        attrs,
      };
      elements.push(el);
    } else {
      // Door/window: hosted line — start/end will be resolved later in parseFloorLayers
      const el: LineElement = {
        geometry: 'line',
        id,
        tableName: layer.tableName,
        discipline: layer.discipline,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        strokeWidth: 0.08,
        attrs,
      };
      el.hostId = csv.host_id ?? '';
      el.locationParam = parseFloat(csv.position ?? '0.5');
      elements.push(el);
    }
  }

  return elements;
}

/** Parse M x1,y1 L x2,y2 from a path d attribute. */
function parseDAttribute(d: string): { x1: number; y1: number; x2: number; y2: number } {
  const m = d.match(/M\s*([-\d.]+)[,\s]+([-\d.]+)\s*L\s*([-\d.]+)[,\s]+([-\d.]+)/);
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return { x1: parseFloat(m[1]), y1: parseFloat(m[2]), x2: parseFloat(m[3]), y2: parseFloat(m[4]) };
}

function parseLineFromPath(
  id: string, path: Element, layer: LayerData, csv?: CsvRow
): LineElement {
  const { x1, y1, x2, y2 } = parseDAttribute(path.getAttribute('d') || '');
  return {
    geometry: 'line',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    strokeWidth: parseFloat(csv?.thickness ?? '0.1'),
    attrs: csvToAttrs(csv, id),
  };
}

function parseSpatialLineFromPath(
  id: string, path: Element, layer: LayerData, csv?: CsvRow
): SpatialLineElement {
  const { x1, y1, x2, y2 } = parseDAttribute(path.getAttribute('d') || '');
  return {
    geometry: 'spatial_line',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    startZ: parseFloat(csv?.start_z ?? '0'),
    endZ: parseFloat(csv?.end_z ?? '0'),
    strokeWidth: parseFloat(csv?.thickness ?? '0.1'),
    attrs: csvToAttrs(csv, id),
  };
}


function applyHostFields(el: CanonicalElement, csv?: CsvRow): void {
  if (!csv) return;
  if (csv.host_id) el.hostId = csv.host_id;
  if (csv.position) el.locationParam = parseFloat(csv.position);
}

function parsePointElement(
  id: string, rect: SVGRectElement, layer: LayerData, csv?: CsvRow
): PointElement {
  const x = parseFloat(rect.getAttribute('x') || '0');
  const y = parseFloat(rect.getAttribute('y') || '0');
  const w = parseFloat(rect.getAttribute('width') || '0.3');
  const h = parseFloat(rect.getAttribute('height') || '0.3');
  return {
    geometry: 'point',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    position: { x: x + w / 2, y: y + h / 2 },
    width: w,
    height: h,
    attrs: csvToAttrs(csv, id),
  };
}

function parsePointFromCircle(
  id: string, circle: Element, layer: LayerData, csv?: CsvRow
): PointElement {
  const cx = parseFloat(circle.getAttribute('cx') || '0');
  const cy = parseFloat(circle.getAttribute('cy') || '0');
  const r = parseFloat(circle.getAttribute('r') || '0.15');
  const d = r * 2;
  return {
    geometry: 'point',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    position: { x: cx, y: cy },
    width: d,
    height: d,
    attrs: csvToAttrs(csv, id),
  };
}

function parsePolygonElement(
  id: string, poly: SVGPolygonElement, layer: LayerData, csv?: CsvRow
): PolygonElement {
  const pointsStr = poly.getAttribute('points') || '';
  const vertices = parsePoints(pointsStr);
  return {
    geometry: 'polygon',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    vertices,
    attrs: csvToAttrs(csv, id),
  };
}

function csvToAttrs(csv: CsvRow | undefined, id: string): Record<string, string> {
  if (!csv) return { id };
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(csv)) {
    if (k && k !== 'id') attrs[k] = v;
  }
  return attrs;
}

/**
 * Validate a CSV layer's rows, filtering out invalid entries.
 * Returns the valid rows and logs warnings for skipped ones.
 */
function validateCsvRows(rows: Map<string, CsvRow>, tableName: string): Map<string, CsvRow> {
  const valid = new Map<string, CsvRow>();
  for (const [id, row] of rows) {
    if (!id || id.trim() === '') {
      console.warn(`[parse] Skipping row with empty id in ${tableName}`);
      continue;
    }
    valid.set(id, row);
  }
  return valid;
}

export function parsePoints(pointsStr: string): Point[] {
  return pointsStr
    .trim()
    .split(/\s+/)
    .map(p => {
      const [x, y] = p.split(',').map(Number);
      return { x, y };
    })
    .filter(p => !isNaN(p.x) && !isNaN(p.y));
}

/**
 * Parse all layers of a floor into CanonicalElement[].
 * Second pass: resolve hosted element geometry from host walls.
 */
export function parseFloorLayers(layers: LayerData[]): CanonicalElement[] {
  const elements: CanonicalElement[] = [];
  for (const layer of layers) {
    elements.push(...parseLayer(layer));
  }

  // Second pass: resolve hosted elements (doors/windows) using wall geometry
  const wallMap = new Map<string, LineElement>();
  for (const el of elements) {
    if (el.geometry === 'line' && (el.tableName === 'wall' || el.tableName === 'structure_wall' || el.tableName === 'curtain_wall')) {
      wallMap.set(el.id, el as LineElement);
    }
  }

  for (const el of elements) {
    if (el.geometry !== 'line') continue;
    const line = el as LineElement;
    if (!line.hostId) continue;

    const hostWall = wallMap.get(line.hostId);
    if (!hostWall) continue;

    const position = line.locationParam ?? 0.5;
    const width = parseFloat(line.attrs.width ?? '0.9');
    const resolved = resolveHostedGeometry(hostWall, position, width);
    line.start = resolved.start;
    line.end = resolved.end;
  }

  return elements;
}
