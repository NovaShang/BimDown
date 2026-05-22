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
  computePerSegmentOutlines,
  ptKey,
  type WallSegment as WallMiterSegment,
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

/** A draw-ready piece of a wall — one polygon plus the edges that should
 *  be stroked as its visible outline. For a solid wall there is one
 *  segment; openings split it into 2+ collinear segments, each with its
 *  own junction-aware outline. */
export interface WallDrawSegment {
  corners: Point[];
  outline: [Point, Point][];
}

export interface LineWallFacts {
  id: string;
  table: string;
  centerline: { start: Point; end: Point; arc?: ArcParams; length: number };
  footprint: Point[];
  segments: WallDrawSegment[];
  openings: WallOpening[];
  thickness: number;
  height: number;
  baseY: number;
  material: string;
}

/**
 * Per-table miter cache for line-archetype elements whose network is
 * scoped to a single table — currently used by the MEP shared helper
 * (duct, pipe, conduit, cable_tray). Walls do NOT call this; they use
 * `getWallNetwork()` which spans wall + structure_wall.
 */
export function getWallMiterAdjustments(
  ctx: GeometryContext,
  table: string,
): Map<string, CornerAdjustment> {
  return ctx.memo(`${table}:miter`, () => {
    const walls = ctx.elementsByTable(table).filter(
      (e): e is LineElement => e.geometry === 'line' || e.geometry === 'spatial_line',
    );
    const segments: WallMiterSegment[] = walls.map(w => ({
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

/** Tables whose walls share a single miter + outline network. Connections
 *  across tables (e.g. `wall` meeting `structure_wall`) miter correctly
 *  and the junction edge is hidden in 2D. */
const WALL_NETWORK_TABLES = ['wall', 'structure_wall'] as const;

export interface WallNetwork {
  adj: Map<string, CornerAdjustment>;
  /** Draw-ready segments keyed by element id. */
  segmentsByEl: Map<string, WallDrawSegment[]>;
}

/**
 * Build the wall network for the current pass: cross-table miter
 * adjustments, plus per-segment draw polygons with junction-aware
 * outlines. Memoized once per pass on the GeometryContext.
 *
 * The same wall may produce multiple segments when openings cut it; all
 * sibling segments share the same element id so they don't visually
 * clip each other.
 */
export function getWallNetwork(ctx: GeometryContext): WallNetwork {
  return ctx.memo('wall-network', () => {
    type W = { el: LineElement; startKey: string; endKey: string };
    const walls: W[] = [];
    for (const table of WALL_NETWORK_TABLES) {
      for (const e of ctx.elementsByTable(table)) {
        if (e.geometry !== 'line' && e.geometry !== 'spatial_line') continue;
        const el = e as LineElement;
        walls.push({
          el,
          startKey: ptKey(el.start.x, el.start.y),
          endKey: ptKey(el.end.x, el.end.y),
        });
      }
    }
    if (walls.length === 0) {
      return { adj: new Map(), segmentsByEl: new Map() };
    }

    const miterInput: WallMiterSegment[] = walls.map(({ el }) => ({
      id: el.id,
      x1: el.start.x, y1: el.start.y,
      x2: el.end.x, y2: el.end.y,
      halfWidth: el.strokeWidth / 2,
      fill: '',
      arc: el.arc,
    }));
    const adj = computeCornerAdjustments(miterInput).adjustments;

    const epCount = new Map<string, number>();
    for (const w of walls) {
      epCount.set(w.startKey, (epCount.get(w.startKey) ?? 0) + 1);
      epCount.set(w.endKey, (epCount.get(w.endKey) ?? 0) + 1);
    }
    const junctionKeys = new Set<string>();
    for (const [k, c] of epCount) if (c >= 2) junctionKeys.add(k);

    const polys: WallPolygon[] = [];
    const elIdxRanges: { elId: string; from: number; to: number }[] = [];
    for (const w of walls) {
      const openings = collectWallOpenings(w.el, ctx);
      const wallPolys = buildWallPolygons(w.el, openings, adj, w.startKey, w.endKey);
      const from = polys.length;
      polys.push(...wallPolys);
      elIdxRanges.push({ elId: w.el.id, from, to: polys.length });
    }

    const outlines = computePerSegmentOutlines(polys, junctionKeys);
    const segmentsByEl = new Map<string, WallDrawSegment[]>();
    for (const { elId, from, to } of elIdxRanges) {
      const segs: WallDrawSegment[] = [];
      for (let i = from; i < to; i++) {
        segs.push({ corners: polys[i].corners, outline: outlines[i] });
      }
      segmentsByEl.set(elId, segs);
    }
    return { adj, segmentsByEl };
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

/**
 * Build the per-wall polygons (one for solid walls, multiple when openings
 * split the wall). Each polygon carries cap classification (whether each
 * cap is the wall's true endpoint vs an interior opening cut) so the
 * downstream outline pass can decide whether to clip it at a junction.
 */
function buildWallPolygons(
  el: LineElement,
  openings: WallOpening[],
  adj: Map<string, CornerAdjustment>,
  startKey: string,
  endKey: string,
): WallPolygon[] {
  if (el.arc) {
    const fp = buildLineWallFootprint(el, adj);
    if (fp.length === 0) return [];
    return [{
      id: el.id, corners: fp, sideLen: fp.length / 2,
      startKey, endKey,
      capStartIsWallEnd: true, capEndIsWallEnd: true,
    }];
  }
  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const wallLen = Math.sqrt(dx * dx + dy * dy);
  if (wallLen < 0.001) return [];
  if (openings.length === 0) {
    const fp = buildLineWallFootprint(el, adj);
    if (fp.length === 0) return [];
    return [{
      id: el.id, corners: fp, sideLen: 2,
      startKey, endKey,
      capStartIsWallEnd: true, capEndIsWallEnd: true,
    }];
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
  return intervals.map(([s, e]) => {
    const capStartIsWallEnd = Math.abs(s) < 1e-6;
    const capEndIsWallEnd = Math.abs(e - wallLen) < 1e-6;
    let p1: Point = { x: el.start.x + ux * s + nx * hw, y: el.start.y + uy * s + ny * hw };
    let p2: Point = { x: el.start.x + ux * e + nx * hw, y: el.start.y + uy * e + ny * hw };
    let p3: Point = { x: el.start.x + ux * e - nx * hw, y: el.start.y + uy * e - ny * hw };
    let p4: Point = { x: el.start.x + ux * s - nx * hw, y: el.start.y + uy * s - ny * hw };
    if (capStartIsWallEnd && startAdj) { p1 = startAdj.left; p4 = startAdj.right; }
    if (capEndIsWallEnd && endAdj) { p2 = endAdj.right; p3 = endAdj.left; }
    return {
      id: el.id, corners: [p1, p2, p3, p4], sideLen: 2,
      startKey, endKey,
      capStartIsWallEnd, capEndIsWallEnd,
    };
  });
}

export function wallGeometryFor(
  el: LineElement,
  ctx: GeometryContext,
  table: string,
): LineWallFacts | null {
  const network = getWallNetwork(ctx);
  const segments = network.segmentsByEl.get(el.id);
  if (!segments || segments.length === 0) return null;
  const footprint = buildLineWallFootprint(el, network.adj);
  if (footprint.length === 0) return null;
  const openings = collectWallOpenings(el, ctx);
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
  return (
    <g data-id={facts.id}>
      {facts.segments.map((seg, i) => (
        <polygon
          key={`f${i}`}
          points={seg.corners.map(p => `${p.x},${p.y}`).join(' ')}
          fill={fill}
          stroke="none"
          data-id={facts.id}
        />
      ))}
      {facts.segments.flatMap((seg, si) =>
        seg.outline.map(([a, b], ei) => (
          <line
            key={`e${si}-${ei}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="butt"
            data-id={facts.id}
          />
        )),
      )}
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
