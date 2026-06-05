import type { LayerData, CsvRow } from '../types.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement, Point, ArcParams } from './elements.ts';
import { geometryTypeForTable, isHostedTable } from './elements.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';

/** Tables that are CSV-only (no geometry file). */
const CSV_ONLY_TABLES = new Set(['door', 'window', 'space', 'mesh', 'connector']);

/** Tables with mixed geometry (different geometry types in the same layer). */
const MIXED_GEOMETRY_TABLES = new Set(['foundation']);

/**
 * Tables that support dual mode: some elements are CSV-only (wall-hosted),
 * others have GeoJSON geometry (slab-hosted). Parsed per-element based on geometry presence.
 */
const DUAL_MODE_TABLES = new Set(['opening']);

/** Tables whose elements live in 3D space (LineString coordinates carry Z). */
const SPATIAL_3D_TABLES = new Set([
  'stair', 'ramp', 'railing',
  'beam', 'brace',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
]);

// ─── GeoJSON types (minimal local definitions) ────────────

type Position2 = [number, number];
type Position3 = [number, number, number];
type Position = Position2 | Position3;

interface PointGeom { type: 'Point'; coordinates: Position }
interface LineStringGeom { type: 'LineString'; coordinates: Position[] }
interface PolygonGeom { type: 'Polygon'; coordinates: Position[][] }
type Geom = PointGeom | LineStringGeom | PolygonGeom;

interface Feature {
  type: 'Feature';
  properties: { id?: string; arc?: ArcParams; rotation?: number; base_offset?: number; top_offset?: number; height_offset?: number; [k: string]: unknown };
  geometry: Geom;
}

interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

function parseFeatureCollection(text: string): FeatureCollection | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) return null;
    return data as FeatureCollection;
  } catch {
    return null;
  }
}

/**
 * Parse a LayerData (raw GeoJSON + CSV) into CanonicalElement[].
 */
export function parseLayer(layer: LayerData): CanonicalElement[] {
  const geoType = geometryTypeForTable(layer.tableName);
  if (!geoType) return [];

  if (CSV_ONLY_TABLES.has(layer.tableName)) {
    return parseCsvOnlyLayer({ ...layer, csvRows: validateCsvRows(layer.csvRows, layer.tableName) });
  }

  if (MIXED_GEOMETRY_TABLES.has(layer.tableName)) {
    return parseMixedGeometryLayer(layer);
  }

  if (DUAL_MODE_TABLES.has(layer.tableName)) {
    return parseDualModeLayer(layer);
  }

  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);
  const fc = parseFeatureCollection(layer.geojsonContent);
  if (!fc) return [];

  const elements: CanonicalElement[] = [];
  const hosted = isHostedTable(layer.tableName);
  const isSpatial = SPATIAL_3D_TABLES.has(layer.tableName);

  for (const feat of fc.features) {
    const id = feat.properties?.id;
    if (!id) continue;
    const csv = csvRows.get(id);
    let el: CanonicalElement | null = null;

    switch (geoType) {
      case 'line':
      case 'spatial_line':
        if (feat.geometry.type !== 'LineString') continue;
        el = geoType === 'spatial_line'
          ? buildSpatialLine(id, feat, layer, csv, isSpatial)
          : buildLine(id, feat, layer, csv);
        break;
      case 'point':
        if (feat.geometry.type !== 'Point') continue;
        el = buildPoint(id, feat, layer, csv);
        break;
      case 'polygon':
        if (feat.geometry.type !== 'Polygon') continue;
        el = buildPolygon(id, feat, layer, csv);
        break;
    }
    if (!el) continue;
    if (hosted) applyHostFields(el, csv);
    elements.push(el);
  }

  return elements;
}

/**
 * Parse a mixed-geometry layer (e.g. foundation) where elements may be
 * Point, LineString, or Polygon depending on subtype.
 */
function parseMixedGeometryLayer(layer: LayerData): CanonicalElement[] {
  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);
  const fc = parseFeatureCollection(layer.geojsonContent);
  if (!fc) return [];

  const elements: CanonicalElement[] = [];
  for (const feat of fc.features) {
    const id = feat.properties?.id;
    if (!id) continue;
    const csv = csvRows.get(id);
    if (feat.geometry.type === 'Point') elements.push(buildPoint(id, feat, layer, csv));
    else if (feat.geometry.type === 'LineString') elements.push(buildLine(id, feat, layer, csv));
    else if (feat.geometry.type === 'Polygon') elements.push(buildPolygon(id, feat, layer, csv));
  }
  return elements;
}

/**
 * Parse a dual-mode layer (opening): features in GeoJSON are slab openings (Polygon),
 * CSV rows without a Feature are wall openings (hosted lines).
 */
function parseDualModeLayer(layer: LayerData): CanonicalElement[] {
  const csvRows = validateCsvRows(layer.csvRows, layer.tableName);
  const elements: CanonicalElement[] = [];
  const seen = new Set<string>();

  const fc = parseFeatureCollection(layer.geojsonContent);
  if (fc) {
    for (const feat of fc.features) {
      const id = feat.properties?.id;
      if (!id || feat.geometry.type !== 'Polygon') continue;
      seen.add(id);
      const csv = csvRows.get(id);
      const el = buildPolygon(id, feat, layer, csv);
      if (csv?.host_id) el.hostId = csv.host_id;
      elements.push(el);
    }
  }

  for (const [id, csv] of csvRows) {
    if (seen.has(id)) continue;
    const attrs = csvToAttrs(csv, id);
    const el: LineElement = {
      geometry: 'line', id,
      tableName: layer.tableName, discipline: layer.discipline,
      start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
      strokeWidth: 0.08, attrs,
    };
    el.hostId = csv.host_id ?? '';
    el.locationParam = parseFloat(csv.position || '0.5') || 0;
    elements.push(el);
  }

  return elements;
}

/**
 * Parse CSV-only layer (door, window, space, mesh) — no GeoJSON geometry file.
 */
function parseCsvOnlyLayer(layer: LayerData): CanonicalElement[] {
  const elements: CanonicalElement[] = [];

  for (const [id, csv] of layer.csvRows) {
    if (!id) continue;
    const attrs = csvToAttrs(csv, id);

    if (layer.tableName === 'space' || layer.tableName === 'mesh') {
      const el: PointElement = {
        geometry: 'point', id,
        tableName: layer.tableName, discipline: layer.discipline,
        position: { x: parseFloat(csv.x ?? '0'), y: parseFloat(csv.y ?? '0') },
        width: 0.3, height: 0.3,
        attrs,
      };
      elements.push(el);
    } else if (layer.tableName === 'connector') {
      // Connector has no independent geometry — position is derived from its
      // host (equipment/terminal/mep_node) at render time. Storage is a
      // PointElement with position (0,0); the host_id + offset attrs carry
      // the actual placement info and are resolved in the element module's
      // geometry() pass.
      const el: PointElement = {
        geometry: 'point', id,
        tableName: layer.tableName, discipline: layer.discipline,
        position: { x: 0, y: 0 },
        width: 0.12, height: 0.12,
        attrs,
      };
      el.hostId = csv.host_id ?? '';
      elements.push(el);
    } else {
      const el: LineElement = {
        geometry: 'line', id,
        tableName: layer.tableName, discipline: layer.discipline,
        start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
        strokeWidth: 0.08, attrs,
      };
      el.hostId = csv.host_id ?? '';
      el.locationParam = parseFloat(csv.position || '0.5') || 0;
      elements.push(el);
    }
  }

  return elements;
}

// ─── Per-geometry builders ────────────────────────────────

function buildLine(id: string, feat: Feature, layer: LayerData, csv?: CsvRow): LineElement {
  const g = feat.geometry as LineStringGeom;
  const a = g.coordinates[0] ?? [0, 0];
  const b = g.coordinates[g.coordinates.length - 1] ?? [0, 0];
  const el: LineElement = {
    geometry: 'line', id,
    tableName: layer.tableName, discipline: layer.discipline,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    strokeWidth: parseFloat(csv?.thickness ?? '0.1'),
    attrs: csvToAttrs(csv, id),
  };
  const arc = feat.properties?.arc;
  if (arc) el.arc = normalizeArc(arc);
  return el;
}

function buildSpatialLine(id: string, feat: Feature, layer: LayerData, csv?: CsvRow, isSpatial = true): SpatialLineElement {
  const g = feat.geometry as LineStringGeom;
  const a = g.coordinates[0] ?? [0, 0, 0];
  const b = g.coordinates[g.coordinates.length - 1] ?? [0, 0, 0];
  const startZ = isSpatial && a.length === 3 ? (a as Position3)[2] : parseFloat(csv?.start_z ?? '0');
  const endZ = isSpatial && b.length === 3 ? (b as Position3)[2] : parseFloat(csv?.end_z ?? '0');
  const attrs = csvToAttrs(csv, id);
  // Back-compat: older Revit exports used start_node_id/end_node_id instead of
  // the spec's from/to for MEP curve connectivity. Alias them so all topology
  // code (rendering, run-drag, fitting derivation) sees from/to. Lossless.
  if (!attrs.from && attrs.start_node_id) attrs.from = attrs.start_node_id;
  if (!attrs.to && attrs.end_node_id) attrs.to = attrs.end_node_id;
  const el: SpatialLineElement = {
    geometry: 'spatial_line', id,
    tableName: layer.tableName, discipline: layer.discipline,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    startZ, endZ,
    strokeWidth: parseFloat(csv?.thickness ?? '0.1'),
    attrs,
  };
  const arc = feat.properties?.arc;
  if (arc) el.arc = normalizeArc(arc);
  return el;
}

function buildPoint(id: string, feat: Feature, layer: LayerData, csv?: CsvRow): PointElement {
  const g = feat.geometry as PointGeom;
  const c = g.coordinates;
  const attrs = csvToAttrs(csv, id);
  const csvSizeX = parseFloat(attrs.size_x);
  const csvSizeY = parseFloat(attrs.size_y);
  // Bounding-box display size from GeoJSON properties (e.g. Revit export):
  // size = [plan width (x), plan depth (y), vertical height (z)]. Drives the 2D
  // footprint and the 3D box; explicit CSV size_x/size_y still win (CSV is the
  // source of truth). The vertical extent feeds attrs.height, which the point
  // modules read for their 3D box.
  const sizeProp = feat.properties?.size;
  const size = Array.isArray(sizeProp) ? (sizeProp as number[]) : null;
  const w = !isNaN(csvSizeX) ? csvSizeX : (typeof size?.[0] === 'number' ? size[0] : 0.3);
  const h = !isNaN(csvSizeY) ? csvSizeY : (typeof size?.[1] === 'number' ? size[1] : (!isNaN(csvSizeX) ? csvSizeX : 0.3));
  if (typeof size?.[2] === 'number' && (attrs.height === undefined || attrs.height === '')) {
    attrs.height = String(size[2]);
  }
  return {
    geometry: 'point', id,
    tableName: layer.tableName, discipline: layer.discipline,
    position: { x: c[0], y: c[1] },
    width: w, height: h,
    attrs,
  };
}

function buildPolygon(id: string, feat: Feature, layer: LayerData, csv?: CsvRow): PolygonElement {
  const g = feat.geometry as PolygonGeom;
  const ring = g.coordinates[0] ?? [];
  // Drop closing duplicate if present
  let end = ring.length;
  if (end >= 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) end -= 1;
  }
  const vertices: Point[] = [];
  for (let i = 0; i < end; i++) {
    vertices.push({ x: ring[i][0], y: ring[i][1] });
  }
  return {
    geometry: 'polygon', id,
    tableName: layer.tableName, discipline: layer.discipline,
    vertices,
    attrs: csvToAttrs(csv, id),
  };
}

/**
 * The bimdown spec stores arc params as {radius, large_arc, sweep}.
 * Editor's internal ArcParams uses {rx, ry, rotation, largeArc, sweep}.
 * Normalize the spec form into the editor form.
 */
function normalizeArc(
  raw: ArcParams | { radius?: number; large_arc?: boolean; sweep?: boolean; rx?: number; ry?: number; rotation?: number; largeArc?: boolean },
): ArcParams {
  const r = (raw as any).radius;
  if (typeof r === 'number') {
    return {
      rx: r, ry: r, rotation: 0,
      largeArc: (raw as any).large_arc === true,
      sweep: (raw as any).sweep === true,
    };
  }
  // Already in editor form
  return raw as ArcParams;
}

function applyHostFields(el: CanonicalElement, csv?: CsvRow): void {
  if (!csv) return;
  if (csv.host_id) el.hostId = csv.host_id;
  if (csv.position) el.locationParam = parseFloat(csv.position) || 0;
}

function csvToAttrs(csv: CsvRow | undefined, id: string): Record<string, string> {
  if (!csv) return { id };
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(csv)) {
    if (k && k !== 'id') attrs[k] = v;
  }
  return attrs;
}

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
