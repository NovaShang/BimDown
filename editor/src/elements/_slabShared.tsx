/**
 * Shared logic for surface-archetype elements with polygon footprint:
 * slab, structure_slab (top-anchored: base_offset = top face) and ceiling.
 */
import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import type { GeometryContext } from './archetypes.ts';
import type { PolygonElement, Point } from '../model/elements.ts';
import { applyOpenings } from '../three/resolve/csg.ts';
import type { SurfacePrimitive, PolygonOpening } from '../three/primitives/types.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

const DEFAULT_THICKNESS = 0.2;

export interface SlabFacts {
  id: string;
  table: string;
  vertices: Point[];
  thickness: number;
  /** Bottom face elevation of the mesh (world Y). */
  baseY: number;
  material: string;
  /** Polygon-opening holes (from opening elements hosting this slab). */
  holes: Point[][];
  /** One-way span direction (degrees CCW from +X), null when not set. */
  spanDirection: number | null;
  /** Where plan symbols go: the outline's area centroid. */
  labelAt: Point;
  /** Element mark for plan tags (structure_slab). */
  number?: string;
}

/** Area centroid of a simple polygon (vertex average when degenerate). */
export function polygonCentroid(vs: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = vs.length || 1;
    return { x: vs.reduce((s, v) => s + v.x, 0) / n, y: vs.reduce((s, v) => s + v.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * One-way span symbol: a double-headed arrow along the span direction through
 * the slab centroid (a short perpendicular tick marks the supported edges).
 */
export function spanSymbol2D(facts: SlabFacts, stroke: string): ReactNode {
  if (facts.spanDirection === null) return null;
  const a = (facts.spanDirection * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  // Arrow length: ~40% of the slab extent along the direction, 1–4 m.
  let lo = Infinity, hi = -Infinity;
  for (const v of facts.vertices) {
    const t = (v.x - facts.labelAt.x) * ux + (v.y - facts.labelAt.y) * uy;
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  const half = Math.max(0.5, Math.min(2, (hi - lo) * 0.2));
  const c = facts.labelAt;
  const p1 = { x: c.x - ux * half, y: c.y - uy * half };
  const p2 = { x: c.x + ux * half, y: c.y + uy * half };
  const head = 0.25;
  const nx = -uy, ny = ux;
  const arrow = (tip: { x: number; y: number }, dir: number) =>
    `M ${tip.x - dir * ux * head + nx * head * 0.5},${tip.y - dir * uy * head + ny * head * 0.5} L ${tip.x},${tip.y} L ${tip.x - dir * ux * head - nx * head * 0.5},${tip.y - dir * uy * head - ny * head * 0.5}`;
  return (
    <g pointerEvents="none">
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={0.03} />
      <path d={`${arrow(p2, 1)} ${arrow(p1, -1)}`} fill="none" stroke={stroke} strokeWidth={0.03} />
      <line x1={c.x - nx * 0.3} y1={c.y - ny * 0.3} x2={c.x + nx * 0.3} y2={c.y + ny * 0.3}
        stroke={stroke} strokeWidth={0.02} />
    </g>
  );
}

export function collectSlabHoles(
  slabId: string,
  ctx: GeometryContext,
): Point[][] {
  const children = ctx.hostedOf(slabId);
  if (children.length === 0) return [];
  const result: Point[][] = [];
  for (const child of children) {
    if (child.tableName !== 'opening') continue;
    if (child.geometry !== 'polygon') continue;
    const v = (child as PolygonElement).vertices;
    if (v.length >= 3) result.push(v);
  }
  return result;
}

export function slabGeometryFor(
  el: PolygonElement,
  ctx: GeometryContext,
  table: string,
  defaultMaterial: string,
  /** Extra elevation offset applied after base_offset (used by ceiling for its
   *  `height_offset` drop). */
  extraOffset = 0,
  /** true: level + base_offset is the TOP face and the body hangs down by
   *  `thickness` (slab / structure_slab, matching the Revit export). false:
   *  it is the bottom face (ceiling). */
  topAnchored = false,
): SlabFacts | null {
  if (el.vertices.length < 3) return null;
  const baseOffset = parseFloat(el.attrs.base_offset || '0') || 0;
  const thickness = parseFloat(el.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
  return {
    id: el.id,
    table,
    vertices: el.vertices,
    thickness,
    baseY: ctx.levelElevation + baseOffset + extraOffset - (topAnchored ? thickness : 0),
    material: el.attrs.material || defaultMaterial,
    // Inner rings of the outline + polygon openings hosted on the slab.
    holes: [...(el.holes ?? []), ...collectSlabHoles(el.id, ctx)],
    spanDirection: parseSpan(el.attrs.span_direction),
    labelAt: polygonCentroid(el.vertices),
  };
}

function parseSpan(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function slabDraw2D(facts: SlabFacts, fill: string, stroke: string): ReactNode {
  const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
  return (
    <g data-id={facts.id}>
      <polygon points={points} fill={fill} stroke={stroke} strokeWidth={0.02} data-id={facts.id} />
      {facts.holes.map((hole, i) => (
        <polygon
          key={i}
          points={hole.map(v => `${v.x},${v.y}`).join(' ')}
          fill="white"
          stroke={stroke}
          strokeWidth={0.02}
          strokeDasharray="0.05 0.03"
          data-id={facts.id}
        />
      ))}
    </g>
  );
}

export function slabDraw3D(facts: SlabFacts, isHL: boolean): ReactNode {
  const shape = new Shape();
  shape.moveTo(facts.vertices[0].x, facts.vertices[0].y);
  for (let i = 1; i < facts.vertices.length; i++) {
    shape.lineTo(facts.vertices[i].x, facts.vertices[i].y);
  }
  shape.closePath();

  let geo: BufferGeometry = new ExtrudeGeometry(shape, { depth: facts.thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, facts.baseY, 0);

  if (facts.holes.length > 0) {
    const polyOpenings: PolygonOpening[] = facts.holes.map((vs, i) => ({
      kind: 'polygon',
      id: `${facts.id}:hole:${i}`,
      vertices: vs,
    }));
    const fakePrim: SurfacePrimitive = {
      kind: 'surface',
      id: `surface:${facts.id}`,
      elementId: facts.id,
      tableName: facts.table,
      footprint: facts.vertices,
      extrudeDirection: { x: 0, y: 1, z: 0 },
      height: facts.thickness,
      origin: { x: 0, y: facts.baseY, z: 0 },
      material: resolveBimMaterial(facts.material, facts.table),
      openings: polyOpenings,
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
