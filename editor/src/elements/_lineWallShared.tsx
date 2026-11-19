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
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { buildStraightWallSolid, buildPiecesSolid } from '../three/utils/wallSolid.ts';
import { resolveTopAttach, wallTopPieces, maxTop, type AttachPiece } from '../geometry/attach.ts';
import { resolvedLayers } from '../model/types/catalog.ts';
import { layerBands, wallFrame, clipToBand, chordAt, type LayerBand } from '../geometry/layerBands.ts';
import { fineJoins, cutBand, cutChord, type FinishCut, type JoinWall } from '../geometry/layerJoins.ts';
import { layerColor, layerFill } from './_layerHatch.tsx';
import { curtainEmbedSpan, curtainWallSpan, embedLength, embedPointAt } from '../geometry/curtainEmbed.ts';

const HOSTED_TABLES = new Set(['door', 'window', 'opening']);
const DEFAULT_HEIGHT = 3.0;

export interface WallOpening {
  hostedId: string;
  /** `curtain_wall`: a curtain wall embedded in this wall (geometry/curtainEmbed.ts). */
  hostedTable: 'door' | 'window' | 'opening' | 'curtain_wall';
  position: number;
  width: number;
  height: number;
  sillHeight: number;
  shape: 'rect' | 'round' | 'arch';
  /** False when the void misses the plan cut plane (an embedded curtain wall
   *  above or below it): the plan keeps the wall solid there. */
  planCut?: boolean;
}

/** A draw-ready piece of a wall — one polygon plus the edges that should
 *  be stroked as its visible outline. For a solid wall there is one
 *  segment; openings split it into 2+ collinear segments, each with its
 *  own junction-aware outline. */
export interface WallDrawSegment {
  corners: Point[];
  outline: [Point, Point][];
}

/** Fine-detail drawing of a wall in a layered tee (geometry/layerJoins.ts). */
export interface WallFineJoin {
  /** Polygons of a stem running through the main wall's finish to its core. */
  corners?: Point[][];
  /** The stem's sides through the finish and its end on the core. */
  lines?: [Point, Point][];
  /** Finish taken out of a main wall by the stems teeing into it. */
  cuts?: FinishCut[];
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
  /** Type layers as bands across the wall (straight typed walls with 2+ layers). */
  layers?: LayerBand[];
  /** Layered tee joins at fine detail. */
  fine?: WallFineJoin;
  /** Top attached to a roof / slab (`top_attach_id`): its underside, and the
   *  wall's own top (absolute) where the footprint is not under it. */
  topAttach?: { surface: AttachPiece[]; ownTop: number };
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

/** Joined by walls (mitres, tees) but drawn on their own: a wall meeting a
 *  curtain wall end to end stops square at it. */
const JOIN_ONLY_TABLES = ['curtain_wall'] as const;

export interface WallNetwork {
  adj: Map<string, CornerAdjustment>;
  /** Draw-ready segments keyed by element id. */
  segmentsByEl: Map<string, WallDrawSegment[]>;
  /** Fine-detail tee joins keyed by element id. */
  fineByEl: Map<string, WallFineJoin>;
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
      return { adj: new Map(), segmentsByEl: new Map(), fineByEl: new Map() };
    }
    const joinOnly: LineElement[] = [];
    for (const table of JOIN_ONLY_TABLES) {
      for (const e of ctx.elementsByTable(table)) {
        if (e.geometry === 'line' && !e.arc) joinOnly.push(e as LineElement);
      }
    }

    const miterInput: WallMiterSegment[] = [...walls.map(w => w.el), ...joinOnly].map(el => ({
      id: el.id,
      x1: el.start.x, y1: el.start.y,
      x2: el.end.x, y2: el.end.y,
      halfWidth: el.strokeWidth / 2,
      fill: '',
      arc: el.arc,
    }));
    const miter = computeCornerAdjustments(miterInput);
    const adj = miter.adjustments;

    const epCount = new Map<string, number>();
    for (const w of walls) {
      epCount.set(w.startKey, (epCount.get(w.startKey) ?? 0) + 1);
      epCount.set(w.endKey, (epCount.get(w.endKey) ?? 0) + 1);
    }
    for (const el of joinOnly) {
      for (const k of [ptKey(el.start.x, el.start.y), ptKey(el.end.x, el.end.y)]) epCount.set(k, (epCount.get(k) ?? 0) + 1);
    }
    const junctionKeys = new Set<string>();
    for (const [k, c] of epCount) if (c >= 2) junctionKeys.add(k);

    const polys: WallPolygon[] = [];
    const elIdxRanges: { elId: string; from: number; to: number }[] = [];
    for (const w of walls) {
      const openings = collectWallOpenings(w.el, ctx);
      const wallPolys = buildWallPolygons(w.el, openings, miter.planAdjustments, w.startKey, w.endKey);
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
    return { adj, segmentsByEl, fineByEl: fineTeeJoins(walls.map(w => w.el), miter, ctx) };
  });
}

/** Layered tees at fine detail: stems run through the main wall's finish to its core. */
function fineTeeJoins(
  walls: LineElement[],
  miter: ReturnType<typeof computeCornerAdjustments>,
  ctx: GeometryContext,
): Map<string, WallFineJoin> {
  const out = new Map<string, WallFineJoin>();
  if (miter.tJunctions.length === 0) return out;
  const byId = new Map<string, JoinWall>();
  const els = new Map<string, LineElement>();
  for (const el of walls) {
    if (el.arc) continue;
    const layers = resolvedLayers(el, ctx.projectTypes());
    byId.set(el.id, {
      id: el.id, start: el.start, end: el.end, thickness: el.strokeWidth,
      bands: layers && layers.length > 1 ? layerBands(layers, el.strokeWidth) : undefined,
    });
    els.set(el.id, el);
  }
  const joins = fineJoins(byId, miter.tJunctions);
  if (joins.stems.size === 0) return out;
  const adj = new Map(miter.planAdjustments);
  const stems = new Set<string>();
  for (const [key, end] of joins.stems) {
    adj.set(key, { left: end.left, right: end.right });
    stems.add(key.slice(0, key.lastIndexOf(':')));
  }
  for (const id of stems) {
    const el = els.get(id)!;
    const polys = buildWallPolygons(el, collectWallOpenings(el, ctx), adj, '', '');
    const lines = [...joins.stems].filter(([k]) => k.startsWith(`${id}:`)).flatMap(([, v]) => v.lines);
    out.set(id, { corners: polys.map(p => p.corners), lines });
  }
  for (const [id, cuts] of joins.cuts) out.set(id, { ...out.get(id), cuts });
  return out;
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
  const embedded = embeddedCurtainWalls(el, ctx);
  if (children.length === 0) return embedded;
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
    // Sill height = base_offset when set. When ABSENT, default a window to a
    // 0.9m sill (matches the window tool's default) so AI-built windows aren't
    // stuck on the floor; doors/openings stay at 0. An explicit "0" is honored
    // (floor-to-ceiling window), so we distinguish absent from zero.
    const rawSill = hosted.attrs.base_offset;
    const sillHeight = (rawSill !== undefined && rawSill !== '')
      ? (parseFloat(rawSill) || 0)
      : (tbl === 'window' ? 0.9 : 0);
    const shape = (hosted.attrs.shape || 'rect') as 'rect' | 'round' | 'arch';
    result.push({ hostedId: hosted.id, hostedTable: tbl, position, width, height, sillHeight, shape });
  }
  result.push(...embedded);
  return result.sort((a, b) => a.position - b.position);
}

/** Plan cut plane height above the level (m), as the plan drawing. */
const PLAN_CUT = 1.2;

/**
 * Voids of the curtain walls embedded in a wall (Revit "Automatically Embed",
 * geometry/curtainEmbed.ts; straight, or arcs on one centre): the overlap
 * along the wall, from the curtain wall's base to its top, clipped to the wall.
 */
export function embeddedCurtainWalls(el: LineElement, ctx: GeometryContext): WallOpening[] {
  const cws = ctx.elementsByTable('curtain_wall');
  if (cws.length === 0) return [];
  const upm = ctx.unitsPerMetre;
  const wall = resolveHeight(el.attrs, ctx.levelElevation, ctx.levelElevations, DEFAULT_HEIGHT * upm);
  const out: WallOpening[] = [];
  for (const c of cws) {
    if (c.geometry !== 'line') continue;
    const cw = c as LineElement;
    const span = curtainEmbedSpan(el, el.strokeWidth, cw, 0.005 * upm);
    if (!span) continue;
    const v = curtainWallSpan(cw.attrs, ctx.levelElevation, ctx.levelElevations, DEFAULT_HEIGHT * upm);
    const sill = Math.max(0, v.baseOffset - wall.baseOffset);
    const top = Math.min(wall.height, v.baseOffset + v.height - wall.baseOffset);
    if (top - sill <= 0.005 * upm) continue;
    const cut = PLAN_CUT * upm;
    out.push({
      hostedId: cw.id, hostedTable: 'curtain_wall',
      position: (span.lo + span.hi) / 2, width: span.hi - span.lo,
      height: top - sill, sillHeight: sill, shape: 'rect',
      planCut: sill <= cut && top >= cut,
    });
  }
  return out;
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
    // Embedded curtain walls cut the arc in plan (doors on arcs keep the full band).
    const cuts = openings.filter(op => op.hostedTable === 'curtain_wall' && op.planCut !== false);
    const fp = buildLineWallFootprint(el, adj);
    if (fp.length === 0) return [];
    if (cuts.length === 0) {
      return [{
        id: el.id, corners: fp, sideLen: fp.length / 2,
        startKey, endKey,
        capStartIsWallEnd: true, capEndIsWallEnd: true,
      }];
    }
    return arcWallPieces(el, cuts, adj, startKey, endKey);
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
    if (op.planCut === false) continue;
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

/** Plan bands of an arc wall between the voids of its embedded curtain walls. */
function arcWallPieces(el: LineElement, cuts: WallOpening[], adj: Map<string, CornerAdjustment>, startKey: string, endKey: string): WallPolygon[] {
  const wallLen = embedLength(el);
  const hw = el.strokeWidth / 2;
  const intervals: [number, number][] = [];
  let cursor = 0;
  for (const op of [...cuts].sort((a, b) => a.position - b.position)) {
    const oLo = Math.max(0, op.position - op.width / 2), oHi = Math.min(wallLen, op.position + op.width / 2);
    if (oLo > cursor + 1e-6) intervals.push([cursor, oLo]);
    cursor = Math.max(cursor, oHi);
  }
  if (cursor < wallLen - 1e-6) intervals.push([cursor, wallLen]);
  const startAdj = adj.get(`${el.id}:start`), endAdj = adj.get(`${el.id}:end`);
  return intervals.map(([s, e]) => {
    const n = Math.max(1, Math.ceil((e - s) / 0.15));
    const left: Point[] = [], right: Point[] = [];
    for (let i = 0; i <= n; i++) {
      const d = s + (e - s) * i / n;
      const p = embedPointAt(el, d);
      const q = embedPointAt(el, Math.min(wallLen, d + 1e-4)), o = embedPointAt(el, Math.max(0, d - 1e-4));
      const tl = Math.hypot(q.x - o.x, q.y - o.y) || 1;
      const nx = -(q.y - o.y) / tl, ny = (q.x - o.x) / tl;
      left.push({ x: p.x + nx * hw, y: p.y + ny * hw });
      right.push({ x: p.x - nx * hw, y: p.y - ny * hw });
    }
    const capStartIsWallEnd = Math.abs(s) < 1e-6, capEndIsWallEnd = Math.abs(e - wallLen) < 1e-6;
    if (capStartIsWallEnd && startAdj) { left[0] = startAdj.left; right[0] = startAdj.right; }
    if (capEndIsWallEnd && endAdj) { left[n] = endAdj.right; right[n] = endAdj.left; }
    return {
      id: el.id, corners: [...left, ...right.reverse()], sideLen: n + 1,
      startKey, endKey, capStartIsWallEnd, capEndIsWallEnd,
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
  // Resolve vertical extent from top_level_id / top_offset / base_offset so the
  // wall rises to its top constraint (e.g. up to the next level) instead of a
  // fixed default. Walls with no top_level_id fall back via resolveHeight.
  const { height, baseOffset } = resolveHeight(
    el.attrs, ctx.levelElevation, ctx.levelElevations, DEFAULT_HEIGHT * ctx.unitsPerMetre,
  );
  const typeLayers = el.arc ? null : resolvedLayers(el, ctx.projectTypes());
  const baseY = ctx.levelElevation + baseOffset;
  // Attach Top: the top follows the roof / slab underside where the wall is under it.
  const surface = resolveTopAttach(el, ctx);
  let topAttach: LineWallFacts['topAttach'];
  let wallHeight = height;
  if (surface && surface.length > 0) {
    topAttach = { surface, ownTop: baseY + height };
    const top = maxTop(wallTopPieces(footprint, surface, baseY + height));
    if (Number.isFinite(top) && top > baseY) wallHeight = top - baseY;
  }
  return {
    id: el.id,
    table,
    centerline: { start: el.start, end: el.end, arc: el.arc, length: chordLen },
    footprint,
    segments,
    openings,
    thickness: el.strokeWidth,
    height: wallHeight,
    baseY,
    material: el.attrs.material || 'concrete',
    layers: typeLayers && typeLayers.length > 1 ? layerBands(typeLayers, el.strokeWidth) : undefined,
    fine: network.fineByEl.get(el.id),
    topAttach,
  };
}

/**
 * Layer fills and the lines between layers, per draw segment: fine detail
 * only (`plan-fine`, shown from ≈ 1:50 by planDetail.ts), so zooming needs
 * no re-render.
 */
function wallLayers2D(facts: LineWallFacts): ReactNode {
  const frame = facts.layers && wallFrame(facts.centerline.start, facts.centerline.end);
  if (!facts.layers || !frame) return null;
  const bands = facts.layers;
  const { start, end } = facts.centerline;
  const cuts = facts.fine?.cuts ?? [];
  const pieces = facts.fine?.corners ?? facts.segments.map(s => s.corners);
  const pts = (poly: Point[]) => poly.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <g className="plan-fine" data-id={facts.id}>
      {pieces.flatMap((corners, si) => bands.flatMap((b, bi) => {
        const poly = clipToBand(corners, frame, b.lo, b.hi);
        if (poly.length < 3) return [];
        // A hairline of the layer's colour closes the seams at mitred corners
        return (cuts.length ? cutBand(poly, start, end, b.lo, b.hi, cuts) : [poly]).map((piece, pi) => (
          <polygon key={`l${si}-${bi}-${pi}`} points={pts(piece)}
            fill={layerFill(b)} stroke={layerColor(b)} strokeWidth={0.004} data-id={facts.id} />
        ));
      }))}
      {pieces.flatMap((corners, si) => bands.slice(1).flatMap((b, bi) => {
        const c = chordAt(corners, frame, b.hi);
        if (!c) return [];
        return (cuts.length ? cutChord(c, start, end, b.hi, cuts) : [c]).map(([p, q], ci) => (
          <line key={`b${si}-${bi}-${ci}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y}
            className="pen-hair" stroke="#4b5563" strokeWidth={0.006} data-id={facts.id} />
        ));
      }))}
    </g>
  );
}

/** Fine detail of a stem in a layered tee: its fill through the finish, its sides and end. */
function wallFineStem2D(facts: LineWallFacts, fill: string, stroke: string): ReactNode {
  const f = facts.fine;
  if (!f?.corners) return null;
  return (
    <g className="plan-fine" data-id={facts.id}>
      {!facts.layers && f.corners.map((c, i) => (
        <polygon key={`f${i}`} points={c.map(p => `${p.x},${p.y}`).join(' ')} fill={fill} stroke={fill} strokeWidth={0.01} data-id={facts.id} />
      ))}
      {(f.lines ?? []).map(([a, b], i) => (
        <line key={`s${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={i % 3 === 2 ? 'pen-hair' : 'pen-cut'}
          stroke={stroke} strokeWidth={0.02} strokeLinecap="square" data-id={facts.id} />
      ))}
    </g>
  );
}

export function wallDraw2D(
  facts: LineWallFacts,
  fill: string,
  stroke: string,
  strokeWidth: number,
): ReactNode {
  if (facts.segments.length === 0) return null;
  // At fine detail a layered wall is drawn by its layers, and a stem running
  // into a layered wall's core by its own outline (wallFineStem2D).
  const coarseOnly = facts.layers || facts.fine?.corners ? 'plan-not-fine' : undefined;
  return (
    <g data-id={facts.id}>
      {facts.segments.map((seg, i) => (
        <polygon
          key={`f${i}`}
          className={coarseOnly}
          points={seg.corners.map(p => `${p.x},${p.y}`).join(' ')}
          fill={fill}
          // A hairline of the fill colour hides the anti-aliasing seam where
          // two mitred / teed wall polygons meet.
          stroke={fill}
          strokeWidth={0.01}
          strokeLinejoin="miter"
          data-id={facts.id}
        />
      ))}
      {wallLayers2D(facts)}
      {wallFineStem2D(facts, fill, stroke)}
      {facts.segments.flatMap((seg, si) =>
        seg.outline.map(([a, b], ei) => (
          <line
            key={`e${si}-${ei}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            className="pen-cut"
            stroke={stroke}
            strokeWidth={strokeWidth}
            // Square caps close the hairline gap where two walls' outline
            // pieces meet end to end (collinear walls, mitred corners).
            strokeLinecap="square"
            data-id={facts.id}
          />
        )),
      )}
    </g>
  );
}

export function wallDraw3D(facts: LineWallFacts, isHL: boolean): ReactNode {
  if (facts.footprint.length < 3) return null;
  if (facts.layers && !isHL) {
    const layered = wallLayers3D(facts);
    if (layered) return layered;
  }
  const geo = wallSolid(facts, facts.footprint);
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

/** One mesh per type layer (air gaps left open), each in its layer's material. */
function wallLayers3D(facts: LineWallFacts): ReactNode {
  const frame = wallFrame(facts.centerline.start, facts.centerline.end);
  if (!frame || !facts.layers) return null;
  const meshes: ReactNode[] = [];
  facts.layers.forEach((b, i) => {
    if (b.function === 'air_gap') return;
    const poly = clipToBand(facts.footprint, frame, b.lo, b.hi);
    if (poly.length < 3) return;
    const material = getBimMaterial(resolveBimMaterial(b.material || facts.material, facts.table));
    meshes.push(
      <mesh key={i} geometry={wallSolid(facts, poly)} material={material}
        castShadow receiveShadow userData={{ elementId: facts.id }} />,
    );
  });
  return meshes.length > 0 ? <group userData={{ elementId: facts.id }}>{meshes}</group> : null;
}

/**
 * Wall solid (the whole footprint or one layer of it) with the wall's openings
 * cut. Straight walls with plain rectangular openings are built directly (same
 * solid as extrude + CSG, ~100× faster); everything else goes through CSG.
 */
export function wallSolid(facts: LineWallFacts, footprint: Point[], withOpenings = true): BufferGeometry {
  const openings = withOpenings ? facts.openings : [];
  const topPieces = facts.topAttach
    ? wallTopPieces(footprint, facts.topAttach.surface, facts.topAttach.ownTop)
    : undefined;
  const direct = facts.centerline.arc ? null : buildStraightWallSolid({
    start: facts.centerline.start, end: facts.centerline.end, footprint,
    thickness: facts.thickness, height: facts.height, baseY: facts.baseY, openings, topPieces,
  });
  if (direct) return direct;
  if (topPieces) {
    // Arc wall or shaped openings under a sloped top: piece prisms, then CSG.
    const body = buildPiecesSolid(topPieces, facts.baseY);
    if (body) return openings.length > 0 ? cutOpenings(body, { ...facts, openings }, footprint) : body;
  }
  return extrudeWallWithCsg({ ...facts, openings }, footprint);
}

/** The wall's solid with its door / window / opening voids and attached top (section drawings, IFC). */
export function wallSolidGeometry(facts: LineWallFacts, footprint: Point[] = facts.footprint): BufferGeometry {
  return wallSolid(facts, footprint);
}

/** Extrude + CSG wall solid (arc walls, shaped or overlapping openings). */
export function extrudeWallWithCsg(facts: LineWallFacts, footprint: Point[] = facts.footprint): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(footprint[0].x, footprint[0].y);
  for (let i = 1; i < footprint.length; i++) {
    shape.lineTo(footprint[i].x, footprint[i].y);
  }
  shape.closePath();
  const geo: BufferGeometry = new ExtrudeGeometry(shape, { depth: facts.height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, facts.baseY, 0);
  return cutOpenings(geo, facts, footprint);
}

/** CSG-subtract the wall's door / window / opening cuts from a wall body. */
function cutOpenings(body: BufferGeometry, facts: LineWallFacts, footprint: Point[]): BufferGeometry {
  let geo = body;
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
      footprint,
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
  return geo;
}

export function wallFillFor(material: string): string {
  const m = (material || '').toLowerCase();
  if (m.includes('concrete')) return '#d4d4d4';
  if (m.includes('metal') || m.includes('steel')) return '#e8e8e8';
  if (m.includes('wood') || m.includes('clt')) return '#d8c0a0';
  return '#f0f0f0';
}
