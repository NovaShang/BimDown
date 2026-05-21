import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { computeCornerAdjustments, type WallSegment, type CornerAdjustment } from '../geometry/miter.ts';
import { tessellateArc, pointOnArc, type ArcParams } from '../geometry/arc.ts';
import { MATERIAL_OPTIONS } from '../model/tableRegistry.ts';
import { applyOpenings } from '../three/resolve/csg.ts';
import type { SurfacePrimitive, ParametricOpening } from '../three/primitives/types.ts';
import { getBimMaterial } from '../three/utils/bimMaterials.ts';
import { resolveBimMaterial } from '../three/utils/bimMaterials.ts';

/** Opening (door / window / line-hosted opening) range along wall centerline. */
export interface WallOpening {
  hostedId: string;
  hostedTable: 'door' | 'window' | 'opening';
  /** Center position in meters from wall start, along centerline. */
  position: number;
  /** Opening width in meters. */
  width: number;
  /** Opening height in meters (for 3D CSG cut). */
  height: number;
  /** Bottom of opening above wall base, in meters (sill height for windows). */
  sillHeight: number;
  /** Profile shape for 3D CSG. */
  shape: 'rect' | 'round' | 'arch';
}

export interface WallFacts {
  id: string;
  centerline: { start: Point; end: Point; arc?: ArcParams; length: number };
  /** Miter-adjusted full polygon footprint (CCW, model-space Y-up).
   *  Used by 3D builder. 2D adapter prefers `segments` for opening cuts. */
  footprint: Point[];
  /** Wall body broken at opening ranges. One polygon per non-opening interval.
   *  Each polygon has miter-adjusted corners only at the wall's actual endpoints. */
  segments: Point[][];
  openings: WallOpening[];
  thickness: number;
  /** 3D extrusion height — informational for draw3D in Step 3c. */
  height: number;
  /** 3D base elevation — informational for draw3D in Step 3c. */
  baseY: number;
  material: string;
}

const DEFAULT_HEIGHT = 3.0;
const WALL_TABLE = 'wall';
const HOSTED_TABLES = new Set(['door', 'window', 'opening']);

// ─── Miter cache (per render pass) ───────────────────────────────────────────

function getMiterAdjustments(ctx: GeometryContext): Map<string, CornerAdjustment> {
  return ctx.memo('wall:miter', () => {
    const walls = ctx.elementsByTable(WALL_TABLE).filter(
      (e): e is LineElement => e.geometry === 'line' || e.geometry === 'spatial_line',
    );
    const segments: WallSegment[] = walls.map(w => ({
      id: w.id,
      x1: w.start.x, y1: w.start.y,
      x2: w.end.x, y2: w.end.y,
      halfWidth: w.strokeWidth / 2,
      fill: '',
      arc: w.arc,
    }));
    return computeCornerAdjustments(segments).adjustments;
  });
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function buildFootprint(el: LineElement, adj: Map<string, CornerAdjustment>): Point[] {
  const hw = el.strokeWidth / 2;

  if (el.arc) {
    const pts = tessellateArc(el.start, el.end, el.arc, 0.15);
    const n = pts.length;
    if (n < 2) return [];
    const leftSide: Point[] = [];
    const rightSide: Point[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const { tangent } = pointOnArc(el.start, el.end, el.arc, t);
      const nx = -tangent.y, ny = tangent.x;
      leftSide.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
      rightSide.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
    }
    const sa = adj.get(`${el.id}:start`);
    const ea = adj.get(`${el.id}:end`);
    if (sa) { leftSide[0] = sa.left; rightSide[0] = sa.right; }
    if (ea) { leftSide[n - 1] = ea.right; rightSide[n - 1] = ea.left; }
    return [...leftSide, ...rightSide.reverse()];
  }

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return [];
  const nx = -dy / len, ny = dx / len;
  let p1: Point = { x: el.start.x + nx * hw, y: el.start.y + ny * hw };
  let p2: Point = { x: el.end.x + nx * hw, y: el.end.y + ny * hw };
  let p3: Point = { x: el.end.x - nx * hw, y: el.end.y - ny * hw };
  let p4: Point = { x: el.start.x - nx * hw, y: el.start.y - ny * hw };

  const sa = adj.get(`${el.id}:start`);
  if (sa) { p1 = sa.left; p4 = sa.right; }
  const ea = adj.get(`${el.id}:end`);
  if (ea) { p2 = ea.right; p3 = ea.left; }
  return [p1, p2, p3, p4];
}

function collectOpenings(el: LineElement, ctx: GeometryContext): WallOpening[] {
  const children = ctx.hostedOf(el.id);
  if (children.length === 0) return [];

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (!el.arc && wallLen < 0.001) return [];

  const ux = wallLen > 0 ? dx / wallLen : 0;
  const uy = wallLen > 0 ? dy / wallLen : 0;

  const result: WallOpening[] = [];
  for (const child of children) {
    if (!HOSTED_TABLES.has(child.tableName)) continue;
    if (child.geometry !== 'line' && child.geometry !== 'spatial_line') continue;
    const hosted = child as LineElement;
    const tbl = child.tableName as 'door' | 'window' | 'opening';

    let position: number;
    let width: number;
    if (el.arc) {
      position = parseFloat(hosted.attrs.position || '0');
      width = parseFloat(hosted.attrs.width || '0.9') || 0.9;
    } else {
      const tStart = (hosted.start.x - el.start.x) * ux + (hosted.start.y - el.start.y) * uy;
      const tEnd   = (hosted.end.x   - el.start.x) * ux + (hosted.end.y   - el.start.y) * uy;
      const tLo = Math.min(tStart, tEnd);
      const tHi = Math.max(tStart, tEnd);
      const span = tHi - tLo;
      width = span > 0.001 ? span : (parseFloat(hosted.attrs.width || '0.9') || 0.9);
      position = (tLo + tHi) / 2;
    }

    const defaultHeight = tbl === 'window' ? 1.2 : 2.1;
    const height = parseFloat(hosted.attrs.height || `${defaultHeight}`) || defaultHeight;
    const sillHeight = parseFloat(hosted.attrs.base_offset || '0') || 0;
    const shape = (hosted.attrs.shape || 'rect') as 'rect' | 'round' | 'arch';

    result.push({ hostedId: hosted.id, hostedTable: tbl, position, width, height, sillHeight, shape });
  }
  return result.sort((a, b) => a.position - b.position);
}

function buildSegments(
  el: LineElement,
  openings: WallOpening[],
  adj: Map<string, CornerAdjustment>,
): Point[][] {
  // Arc walls fall back to single polygon for now (opening cuts on arcs is harder).
  if (el.arc) {
    const fp = buildFootprint(el, adj);
    return fp.length > 0 ? [fp] : [];
  }

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 0.001) return [];

  if (openings.length === 0) {
    const fp = buildFootprint(el, adj);
    return fp.length > 0 ? [fp] : [];
  }

  const ux = dx / wallLen, uy = dy / wallLen;
  const nx = -uy, ny = ux;
  const hw = el.strokeWidth / 2;
  const startAdj = adj.get(`${el.id}:start`);
  const endAdj = adj.get(`${el.id}:end`);

  // Non-opening intervals [s, e] along centerline ∈ [0, wallLen].
  const intervals: [number, number][] = [];
  let cursor = 0;
  for (const op of openings) {
    const oLo = Math.max(0, op.position - op.width / 2);
    const oHi = Math.min(wallLen, op.position + op.width / 2);
    if (oLo > cursor + 1e-6) intervals.push([cursor, oLo]);
    cursor = Math.max(cursor, oHi);
  }
  if (cursor < wallLen - 1e-6) intervals.push([cursor, wallLen]);
  if (intervals.length === 0) return [];

  return intervals.map(([s, e], idx) => {
    const isFirst = idx === 0 && Math.abs(s) < 1e-6;
    const isLast = idx === intervals.length - 1 && Math.abs(e - wallLen) < 1e-6;

    let p1: Point = { x: el.start.x + ux * s + nx * hw, y: el.start.y + uy * s + ny * hw };
    let p2: Point = { x: el.start.x + ux * e + nx * hw, y: el.start.y + uy * e + ny * hw };
    let p3: Point = { x: el.start.x + ux * e - nx * hw, y: el.start.y + uy * e - ny * hw };
    let p4: Point = { x: el.start.x + ux * s - nx * hw, y: el.start.y + uy * s - ny * hw };

    if (isFirst && startAdj) { p1 = startAdj.left; p4 = startAdj.right; }
    if (isLast && endAdj)   { p2 = endAdj.right;  p3 = endAdj.left;  }
    return [p1, p2, p3, p4];
  });
}

function fillFor(material: string): string {
  const m = (material || '').toLowerCase();
  if (m.includes('concrete')) return '#d4d4d4';
  if (m.includes('metal') || m.includes('steel')) return '#e8e8e8';
  return '#f0f0f0';
}

// ─── Module ──────────────────────────────────────────────────────────────────

export const wallModule: ElementModule<WallFacts> = {
  table: WALL_TABLE,
  discipline: 'architecture',
  archetype: 'line',
  prefix: 'w',
  hasVerticalSpan: true,
  csvHeaders: ['number', 'base_offset', 'top_level_id', 'top_offset', 'material', 'thickness'],
  defaults: {
    base_offset: '0',
    thickness: '0.2',
    top_level_id: '',
    top_offset: '0',
    material: 'concrete',
  },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.01, step: 0.01 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Walls', color: '#1a1a2e', icon: '▬', order: 1 },
  renderZIndex: 40,

  geometry(el: CanonicalElement, ctx: GeometryContext): WallFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const w = el as LineElement;

    const adj = getMiterAdjustments(ctx);
    const footprint = buildFootprint(w, adj);
    if (footprint.length === 0) return null;

    const openings = collectOpenings(w, ctx);
    const segments = buildSegments(w, openings, adj);

    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const chordLen = Math.sqrt(dx * dx + dy * dy);
    const baseOffset = parseFloat(w.attrs.base_offset || '0');

    return {
      id: w.id,
      centerline: { start: w.start, end: w.end, arc: w.arc, length: chordLen },
      footprint,
      segments,
      openings,
      thickness: w.strokeWidth,
      // TODO Step 3c: resolve top_level_id + top_offset for real height.
      height: DEFAULT_HEIGHT,
      baseY: ctx.levelElevation + baseOffset,
      material: w.attrs.material || 'concrete',
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    if (facts.segments.length === 0) return null;
    const fill = fillFor(facts.material);
    const stroke = drawCtx.selected ? '#3a7bff' : '#1a1a2e';
    const strokeWidth = drawCtx.selected ? 0.04 : 0.03;

    // Each segment is a separate polygon (allows opening gaps in fill + outline).
    // All polygons carry the same data-id so hit-testing routes to the wall.
    return (
      <g data-id={facts.id}>
        {facts.segments.map((seg, i) => (
          <polygon
            key={i}
            points={seg.map(p => `${p.x},${p.y}`).join(' ')}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="miter"
            data-id={facts.id}
          />
        ))}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    if (facts.footprint.length < 3) return null;

    // Extrude the (miter-adjusted) footprint vertically.
    const shape = new Shape();
    shape.moveTo(facts.footprint[0].x, facts.footprint[0].y);
    for (let i = 1; i < facts.footprint.length; i++) {
      shape.lineTo(facts.footprint[i].x, facts.footprint[i].y);
    }
    shape.closePath();

    let geo: BufferGeometry = new ExtrudeGeometry(shape, { depth: facts.height, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, facts.baseY, 0);

    // Build a SurfacePrimitive-shape payload and reuse the existing CSG opening cut.
    if (facts.openings.length > 0) {
      const parametric: ParametricOpening[] = facts.openings.map(op => ({
        kind: 'parametric',
        id: op.hostedId,
        shape: op.shape,
        // applyOpenings expects 'position' as distance from wall start (left edge).
        position: op.position - op.width / 2,
        width: op.width,
        height: op.height,
        sillHeight: op.sillHeight,
      }));
      const fakePrim: SurfacePrimitive = {
        kind: 'surface',
        id: `surface:${facts.id}`,
        elementId: facts.id,
        tableName: 'wall',
        footprint: facts.footprint,
        extrudeDirection: { x: 0, y: 1, z: 0 },
        height: facts.height,
        origin: { x: 0, y: facts.baseY, z: 0 },
        material: resolveBimMaterial(facts.material, 'wall'),
        miterMeta: {
          startX: facts.centerline.start.x,
          startY: facts.centerline.start.y,
          endX:   facts.centerline.end.x,
          endY:   facts.centerline.end.y,
          halfWidth: facts.thickness / 2,
          arc: facts.centerline.arc,
        },
        openings: parametric,
      };
      // Re-translate geo to model origin since miterMeta expects world XY-Z math
      // identical to the V1 builder. Our extrude already placed it; CSG matches.
      const cut = applyOpenings(geo, fakePrim);
      if (cut !== geo) geo.dispose();
      geo = cut;
    }

    const material = getBimMaterial(resolveBimMaterial(facts.material, 'wall'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <mesh
        geometry={geo}
        material={isHL ? undefined : material}
        castShadow
        receiveShadow
        userData={{ elementId: facts.id }}
      >
        {isHL && (
          <meshStandardMaterial
            attach="material"
            color="#06b6d4"
            transparent={material.transparent}
            opacity={Math.max(material.opacity, 0.4)}
          />
        )}
      </mesh>
    );
  },

  bbox(facts) {
    if (facts.footprint.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.footprint) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(wallModule);
