import type { LayerData, CsvRow } from '../types.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement, Point } from './elements.ts';
import { geometryTypeForTable, isHostedTable } from './elements.ts';
import { resolveHostedGeometry } from './hosted.ts';

const parser = new DOMParser();

/** Tables that are CSV-only (no SVG geometry file). */
const CSV_ONLY_TABLES = new Set(['door', 'window', 'space', 'opening']);

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

  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);

  const doc = parser.parseFromString(layer.svgContent, 'image/svg+xml');
  const g = doc.querySelector('g');
  if (!g) return [];

  const elements: CanonicalElement[] = [];

  const hosted = isHostedTable(layer.tableName);

  switch (geoType) {
    case 'line':
    case 'spatial_line': {
      const lines = g.querySelectorAll('line');
      for (const line of lines) {
        const id = line.getAttribute('id') || '';
        if (!id) continue;
        const csv = csvRows.get(id);
        const el = geoType === 'spatial_line'
          ? parseSpatialLineElement(id, line, layer, csv)
          : parseLineElement(id, line, layer, csv);
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

function parseLineElement(
  id: string, line: SVGLineElement, layer: LayerData, csv?: CsvRow
): LineElement {
  return {
    geometry: 'line',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    start: {
      x: parseFloat(line.getAttribute('x1') || '0'),
      y: parseFloat(line.getAttribute('y1') || '0'),
    },
    end: {
      x: parseFloat(line.getAttribute('x2') || '0'),
      y: parseFloat(line.getAttribute('y2') || '0'),
    },
    strokeWidth: parseFloat(line.getAttribute('stroke-width') || '0.1'),
    attrs: csvToAttrs(csv, id),
  };
}

function parseSpatialLineElement(
  id: string, line: SVGLineElement, layer: LayerData, csv?: CsvRow
): SpatialLineElement {
  return {
    geometry: 'spatial_line',
    id,
    tableName: layer.tableName,
    discipline: layer.discipline,
    start: {
      x: parseFloat(line.getAttribute('x1') || '0'),
      y: parseFloat(line.getAttribute('y1') || '0'),
    },
    end: {
      x: parseFloat(line.getAttribute('x2') || '0'),
      y: parseFloat(line.getAttribute('y2') || '0'),
    },
    startZ: parseFloat(csv?.start_z ?? '0'),
    endZ: parseFloat(csv?.end_z ?? '0'),
    strokeWidth: parseFloat(line.getAttribute('stroke-width') || '0.1'),
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
