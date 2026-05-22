/**
 * Shared logic for surface-archetype elements with polygon footprint:
 * slab, structure_slab. Could extend to roof / ceiling / foundation later.
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
  baseY: number;
  material: string;
  /** Polygon-opening holes (from opening elements hosting this slab). */
  holes: Point[][];
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
): SlabFacts | null {
  if (el.vertices.length < 3) return null;
  const baseOffset = parseFloat(el.attrs.base_offset || '0') || 0;
  const thickness = parseFloat(el.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
  return {
    id: el.id,
    table,
    vertices: el.vertices,
    thickness,
    baseY: ctx.levelElevation + baseOffset + extraOffset,
    material: el.attrs.material || defaultMaterial,
    holes: collectSlabHoles(el.id, ctx),
  };
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
