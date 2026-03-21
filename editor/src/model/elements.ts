export type Point = { x: number; y: number };

export interface BaseElement {
  id: string;
  tableName: string;
  discipline: string;
  attrs: Record<string, string>;
}

export interface LineElement extends BaseElement {
  geometry: 'line';
  start: Point;
  end: Point;
  strokeWidth: number;
}

export interface PointElement extends BaseElement {
  geometry: 'point';
  position: Point;
  width: number;
  height: number;
}

export interface PolygonElement extends BaseElement {
  geometry: 'polygon';
  vertices: Point[];
}

export type CanonicalElement = LineElement | PointElement | PolygonElement;

// Which geometry type each table uses
const LINE_TABLES = new Set([
  'wall', 'structure_wall', 'door', 'window',
  'duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace',
]);
const POINT_TABLES = new Set([
  'column', 'structure_column', 'equipment', 'terminal',
]);
const POLYGON_TABLES = new Set([
  'space', 'slab', 'structure_slab', 'stair',
]);

export function geometryTypeForTable(tableName: string): 'line' | 'point' | 'polygon' | null {
  if (LINE_TABLES.has(tableName)) return 'line';
  if (POINT_TABLES.has(tableName)) return 'point';
  if (POLYGON_TABLES.has(tableName)) return 'polygon';
  return null;
}
