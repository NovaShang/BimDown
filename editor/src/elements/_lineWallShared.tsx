/**
 * Shared logic for line-archetype "wall-like" elements: wall, structure_wall.
 * Each module imports these helpers and provides its own table key, defaults,
 * 2D style, and material.
 */
import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import type { GeometryContext } from './archetypes.ts';
import type { LineElement, Point } from '../model/elements.ts';
import {
  computeCornerAdjustments,
  computeOuterEdgesByEl,
  ptKey,
  type WallSegment,
  type CornerAdjustment,
  type WallPolygon,
} from '../geometry/miter.ts';
import { tessellateArc, pointOnArc, type ArcParams } from '../geometry/arc.ts';
import { applyOpenings } from '../three/resolve/csg.ts';
import type { SurfacePrimitive, ParametricOpening } from '../three/primitives/types.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const HOSTED_TABLES = new Set(['door', 'window', 'opening']);
const DEFAULT_HEIGHT = 3.0;

export interface WallOpening {
  hostedId: string;
  hostedTable: 'door' | 'window' | 'opening';
  position: number;
  width: number;
  height: number;
  sillHeight: number;
  shape: 'rect' | 'round' | 'arch';
}

export interface LineWallFacts {
  id: string;
  table: string;
  centerline: { start: Point; end: Point; arc?: ArcParams; length: number };
  footprint: Point[];
  segments: Point[][];
  /** Subset of footprint edges that face outside the wall network. Drawn as
   *  the visible outline; inner edges at junctions are skipped so connected
   *  walls render as a single contiguous shape. */
  outerEdges: [Point, Point][];
  openings: WallOpening[];
  thickness: number;
  height: number;
  baseY: number;
  material: string;
}

export function getWallMiterAdjustments(
  ctx: GeometryContext,
  table: string,
): Map<string, CornerAdjustment> {
  return ctx.memo(`${table}:miter`, () => {
    const walls = ctx.elementsByTable(table).filter(
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

/**
 * Per-table cache: for each wall in `table`, return the set of footprint
 * edges that should be drawn as the visible outline. Edges shared with an
 * adjacent wall (junction) are excluded — so connected walls visually
 * merge into one contiguous shape.
 */
export function getWallOuterEdges(
  ctx: GeometryContext,
  table: string,
): Map<string, [Point, Point][]> {
  return ctx.memo(`${table}:outerEdges`, () => {
    const walls = ctx.elementsByTable(table).filter(
      (e): e is LineElement => e.geometry === 'line' || e.geometry === 'spatial_line',
    );
    if (walls.length === 0) return new Map();
    const adj = getWallMiterAdjustments(ctx, table);
    const polygons: WallPolygon[] = [];
    for (const w of walls) {
      const fp = buildLineWallFootprint(w, adj);
      if (fp.length === 0) continue;
      const sideLen = fp.length / 2;
      polygons.push({
        id: w.id,
        corners: fp,
        sideLen,
        startKey: ptKey(w.start.x, w.start.y),
        endKey: ptKey(w.end.x, w.end.y),
      });
    }
    const epCount = new Map<string, number>();
    for (const p of polygons) {
      epCount.set(p.startKey, (epCount.get(p.startKey) ?? 0) + 1);
      epCount.set(p.endKey, (epCount.get(p.endKey) ?? 0) + 1);
    }
    const junctionKeys = new Set<string>();
    for (const [k, c] of epCount) if (c >= 2) junctionKeys.add(k);
    return computeOuterEdgesByEl(polygons, junctionKeys);
  });
}

export function buildLineWallFootprint(
  el: LineElement,
  adj: Map<string, CornerAdjustment>,
): Point[] {
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

export function collectWallOpenings(el: LineElement, ctx: GeometryContext): WallOpening[] {
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
    let position: number, width: number;
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
    const defaultH = tbl === 'window' ? 1.2 : 2.1;
    const height = parseFloat(hosted.attrs.height || `${defaultH}`) || defaultH;
    const sillHeight = parseFloat(hosted.attrs.base_offset || '0') || 0;
    const shape = (hosted.attrs.shape || 'rect') as 'rect' | 'round' | 'arch';
    result.push({ hostedId: hosted.id, hostedTable: tbl, position, width, height, sillHeight, shape });
  }
  return result.sort((a, b) => a.position - b.position);
}

export function buildWallSegments(
  el: LineElement,
  openings: WallOpening[],
  adj: Map<string, CornerAdjustment>,
): Point[][] {
  if (el.arc) {
    const fp = buildLineWallFootprint(el, adj);
    return fp.length > 0 ? [fp] : [];
  }
  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 0.001) return [];
  if (openings.length === 0) {
    const fp = buildLineWallFootprint(el, adj);
    return fp.length > 0 ? [fp] : [];
  }
  const ux = dx / wallLen, uy = dy / wallLen;
  const nx = -uy, ny = ux;
  const hw = el.strokeWidth / 2;
  const startAdj = adj.get(`${el.id}:start`);
  const endAdj = adj.get(`${el.id}:end`);
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

export function wallGeometryFor(
  el: LineElement,
  ctx: GeometryContext,
  table: string,
): LineWallFacts | null {
  const adj = getWallMiterAdjustments(ctx, table);
  const footprint = buildLineWallFootprint(el, adj);
  if (footprint.length === 0) return null;
  const openings = collectWallOpenings(el, ctx);
  const segments = buildWallSegments(el, openings, adj);
  const outerEdges = getWallOuterEdges(ctx, table).get(el.id) ?? [];
  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  const baseOffset = parseFloat(el.attrs.base_offset || '0') || 0;
  return {
    id: el.id,
    table,
    centerline: { start: el.start, end: el.end, arc: el.arc, length: chordLen },
    footprint,
    segments,
    outerEdges,
    openings,
    thickness: el.strokeWidth,
    height: DEFAULT_HEIGHT,
    baseY: ctx.levelElevation + baseOffset,
    material: el.attrs.material || 'concrete',
  };
}

export function wallDraw2D(
  facts: LineWallFacts,
  fill: string,
  stroke: string,
  strokeWidth: number,
): ReactNode {
  if (facts.segments.length === 0) return null;

  // Common case: no openings → render fill polygon without stroke and use
  // junction-clipped outerEdges for the outline. This makes connected walls
  // visually merge at corners.
  if (facts.openings.length === 0 && facts.outerEdges.length > 0) {
    return (
      <g data-id={facts.id}>
        {facts.segments.map((seg, i) => (
          <polygon
            key={`f${i}`}
            points={seg.map(p => `${p.x},${p.y}`).join(' ')}
            fill={fill}
            stroke="none"
            data-id={facts.id}
          />
        ))}
        {facts.outerEdges.map(([a, b], i) => (
          <line
            key={`e${i}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="butt"
            data-id={facts.id}
          />
        ))}
      </g>
    );
  }

  // Wall has openings: keep per-segment stroke (each segment has its own
  // cap edges from the cuts). Junction cleanup for this branch is a TODO.
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
}

export function wallDraw3D(facts: LineWallFacts, isHL: boolean): ReactNode {
  if (facts.footprint.length < 3) return null;
  const shape = new Shape();
  shape.moveTo(facts.footprint[0].x, facts.footprint[0].y);
  for (let i = 1; i < facts.footprint.length; i++) {
    shape.lineTo(facts.footprint[i].x, facts.footprint[i].y);
  }
  shape.closePath();
  let geo: BufferGeometry = new ExtrudeGeometry(shape, { depth: facts.height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, facts.baseY, 0);
  if (facts.openings.length > 0) {
    const parametric: ParametricOpening[] = facts.openings.map(op => ({
      kind: 'parametric',
      id: op.hostedId,
      shape: op.shape,
      position: op.position - op.width / 2,
      width: op.width,
      height: op.height,
      sillHeight: op.sillHeight,
    }));
    const fakePrim: SurfacePrimitive = {
      kind: 'surface',
      id: `surface:${facts.id}`,
      elementId: facts.id,
      tableName: facts.table,
      footprint: facts.footprint,
      extrudeDirection: { x: 0, y: 1, z: 0 },
      height: facts.height,
      origin: { x: 0, y: facts.baseY, z: 0 },
      material: resolveBimMaterial(facts.material, facts.table),
      miterMeta: {
        startX: facts.centerline.start.x, startY: facts.centerline.start.y,
        endX:   facts.centerline.end.x,   endY:   facts.centerline.end.y,
        halfWidth: facts.thickness / 2,
        arc: facts.centerline.arc,
      },
      openings: parametric,
    };
    const cut = applyOpenings(geo, fakePrim);
    if (cut !== geo) geo.dispose();
    geo = cut;
  }
  const material = getBimMaterial(resolveBimMaterial(facts.material, facts.table));
  return (
    <mesh
      geometry={geo}
      material={isHL ? undefined : material}
      castShadow
      receiveShadow
      userData={{ elementId: facts.id }}
    >
      {isHL && (
        <meshStandardMaterial attach="material" color="#06b6d4"
          transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
      )}
    </mesh>
  );
}

export function wallFillFor(material: string): string {
  const m = (material || '').toLowerCase();
  if (m.includes('concrete')) return '#d4d4d4';
  if (m.includes('metal') || m.includes('steel')) return '#e8e8e8';
  if (m.includes('wood') || m.includes('clt')) return '#d8c0a0';
  return '#f0f0f0';
}
