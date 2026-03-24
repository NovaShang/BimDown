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

/** Compute axis-aligned bounding box from element coordinates. Returns null if no geometry. */
export function computeBounds(elements: CanonicalElement[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const el of elements) {
    switch (el.geometry) {
      case 'line':
      case 'spatial_line': {
        const hw = el.strokeWidth / 2;
        minX = Math.min(minX, el.start.x - hw, el.end.x - hw);
        minY = Math.min(minY, el.start.y - hw, el.end.y - hw);
        maxX = Math.max(maxX, el.start.x + hw, el.end.x + hw);
        maxY = Math.max(maxY, el.start.y + hw, el.end.y + hw);
        break;
      }
      case 'point': {
        minX = Math.min(minX, el.position.x - el.width / 2);
        minY = Math.min(minY, el.position.y - el.height / 2);
        maxX = Math.max(maxX, el.position.x + el.width / 2);
        maxY = Math.max(maxY, el.position.y + el.height / 2);
        break;
      }
      case 'polygon': {
        for (const v of el.vertices) {
          minX = Math.min(minX, v.x);
          minY = Math.min(minY, v.y);
          maxX = Math.max(maxX, v.x);
          maxY = Math.max(maxY, v.y);
        }
        break;
      }
    }
  }

  if (!isFinite(minX)) return null;

  // Add small margin (5%)
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const mx = w * 0.05;
  const my = h * 0.05;
  return { x: minX - mx, y: -(maxY + my), w: w + mx * 2, h: h + my * 2 };
}
