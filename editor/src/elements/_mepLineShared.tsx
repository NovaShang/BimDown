/**
 * Shared logic for spatial-line MEP elements: duct, pipe, conduit, cable_tray.
 * They share 2D rendering (miter-joined footprint + colored stroke) and 3D
 * rendering (profile sweep along centerline). They differ in fill/stroke
 * colors, default cross-section shape, and defaults.
 *
 * topo-line archetype today degrades to spatial-line behavior; Connector
 * support (Step 6 Part B) will extend WallFacts-style facts to expose
 * connector slots when the schema lands.
 */
import type { ReactNode } from 'react';
import { ExtrudeGeometry } from 'three';
import type { GeometryContext } from './archetypes.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { shapeFromAttrs, createProfile } from '../three/primitives/profiles.ts';
import { buildLineWallFootprint } from './_lineWallShared.tsx';
import {
  computeCornerAdjustments,
  type WallSegment as WallMiterSegment,
  type CornerAdjustment,
} from '../geometry/miter.ts';

export interface MepLineFacts {
  id: string;
  table: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  sizeX: number;
  sizeY: number;
  shape: string;          // 'round' | 'rect' | structural shapes (rare for MEP)
  baseY: number;
  material: string;
  systemType: string;
  /** Miter-adjusted 2D footprint (plan view). */
  footprint: Point[];
  /** Chord length in plan view. */
  horLen: number;
}

/** Read (startZ, endZ) for an MEP line in the same way the geometry pass does. */
function readZ(ln: LineElement): { startZ: number; endZ: number } {
  const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
  if ((ln as unknown as { geometry: string }).geometry === 'spatial_line') {
    const sp = ln as unknown as SpatialLineElement;
    return { startZ: sp.startZ, endZ: sp.endZ };
  }
  return {
    startZ: parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset,
    endZ: parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset,
  };
}

/**
 * MEP miter cache. Like the wall variant, but buckets lines by (startZ, endZ)
 * — two MEP segments that happen to share a 2D endpoint but live at different
 * Z elevations are NOT actually connected in 3D, so they must not share a
 * miter join in plan view. Within a single Z bucket the miter logic is the
 * same as for walls.
 */
function getMepMiterAdjustments(
  ctx: GeometryContext,
  table: string,
): Map<string, CornerAdjustment> {
  return ctx.memo(`${table}:mep-miter`, () => {
    const lines = ctx.elementsByTable(table).filter(
      (e): e is LineElement => e.geometry === 'line' || e.geometry === 'spatial_line',
    );
    const buckets = new Map<string, LineElement[]>();
    for (const ln of lines) {
      const { startZ, endZ } = readZ(ln);
      // Quantize to 1mm to avoid floating-point bucket splits.
      const key = `${Math.round(startZ * 1000)}/${Math.round(endZ * 1000)}`;
      const list = buckets.get(key) ?? [];
      list.push(ln);
      buckets.set(key, list);
    }
    const merged = new Map<string, CornerAdjustment>();
    for (const list of buckets.values()) {
      const segments: WallMiterSegment[] = list.map(w => ({
        id: w.id,
        x1: w.start.x, y1: w.start.y,
        x2: w.end.x, y2: w.end.y,
        halfWidth: w.strokeWidth / 2,
        fill: '',
        arc: w.arc,
      }));
      const adj = computeCornerAdjustments(segments).adjustments;
      for (const [k, v] of adj) merged.set(k, v);
    }
    return merged;
  });
}

export function mepLineGeometry(
  el: CanonicalElement,
  ctx: GeometryContext,
  table: string,
  defaultShape: 'round' | 'rect',
): MepLineFacts | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const ln = el as LineElement;
  const dx = ln.end.x - ln.start.x;
  const dy = ln.end.y - ln.start.y;
  const horLen = Math.sqrt(dx * dx + dy * dy);
  if (horLen < 0.001) return null;

  const adj = getMepMiterAdjustments(ctx, table);
  const footprint = buildLineWallFootprint(ln, adj);
  if (footprint.length === 0) return null;

  const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
  let startZ = baseOffset, endZ = baseOffset;
  // Spatial-line carries explicit Z; line falls back to attr or base_offset.
  if (el.geometry === 'spatial_line') {
    const sp = el as SpatialLineElement;
    startZ = sp.startZ; endZ = sp.endZ;
  } else {
    startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
    endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
  }

  const sizeX = parseFloat(ln.attrs.size_x || '0.2') || 0.2;
  const sizeY = parseFloat(ln.attrs.size_y || '0.2') || 0.2;

  return {
    id: ln.id,
    table,
    start: ln.start,
    end: ln.end,
    startZ, endZ,
    sizeX, sizeY,
    shape: ln.attrs.shape || defaultShape,
    baseY: ctx.levelElevation,
    material: ln.attrs.material || '',
    systemType: ln.attrs.system_type || '',
    footprint,
    horLen,
  };
}

export function mepLineDraw2D(
  facts: MepLineFacts,
  fill: string,
  stroke: string,
  strokeWidth: number,
): ReactNode {
  const points = facts.footprint.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <polygon
      points={points}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinejoin="miter"
      data-id={facts.id}
    />
  );
}

export function mepLineDraw3D(facts: MepLineFacts, isHL: boolean): ReactNode {
  const dx = facts.end.x - facts.start.x;
  const dy = facts.end.y - facts.start.y;
  const dz = facts.endZ - facts.startZ;
  const len3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len3D < 0.001) return null;

  const profile = shapeFromAttrs(facts.shape, facts.sizeX, facts.sizeY);
  const shape = createProfile(profile);
  const geo = new ExtrudeGeometry(shape, { depth: len3D, bevelEnabled: false });

  // Orient profile along the 3D centerline. ExtrudeGeometry extrudes along
  // local +Z; rotate so local +Z points from start to end.
  // Compose: rotate around X by tilt angle, then around Y by horizontal angle.
  const angleY = Math.atan2(-dy, dx);
  const angleX = -Math.atan2(dz, Math.sqrt(dx * dx + dy * dy));

  const material = getBimMaterial(resolveBimMaterial(facts.material, facts.table));
  return (
    <mesh
      geometry={geo}
      position={[facts.start.x, facts.baseY + facts.startZ, -facts.start.y]}
      rotation={[angleX, angleY, 0]}
      material={isHL ? undefined : material}
      userData={{ elementId: facts.id }}
    >
      {isHL && (
        <meshStandardMaterial attach="material" color="#06b6d4"
          transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
      )}
    </mesh>
  );
}
