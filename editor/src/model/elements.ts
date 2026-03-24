export {
  geometryTypeForTable,
  placementTypeForTable,
  isHostedTable,
  hostTablesFor,
  widthAttrFor,
} from './tableRegistry.ts';
export type { GeometryType, PlacementType } from './tableRegistry.ts';

export type Point = { x: number; y: number };

export interface BaseElement {
  id: string;
  tableName: string;
  discipline: string;
  attrs: Record<string, string>;
  hostId?: string;
  locationParam?: number;
}

export interface LineElement extends BaseElement {
  geometry: 'line';
  start: Point;
  end: Point;
  strokeWidth: number;
}

export interface SpatialLineElement extends BaseElement {
  geometry: 'spatial_line';
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
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

export type CanonicalElement = LineElement | SpatialLineElement | PointElement | PolygonElement;
