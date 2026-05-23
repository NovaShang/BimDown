/**
 * Roof — surface archetype, supports flat/gable/hip/shed/mansard via slope.
 * Delegates 3D geometry to three/utils/roofGeometry.ts (handles pitched shapes).
 * 2D shows footprint + ridge/hip/break lines + slope arrows for non-flat types.
 */
import type { ReactNode } from 'react';
import { type BufferGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement, Point } from '../model/elements.ts';
import { createRoofGeometry } from '../three/utils/roofGeometry.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { applyOpenings } from '../three/resolve/csg.ts';
import type { SurfacePrimitive, PolygonOpening } from '../three/primitives/types.ts';
import { MATERIAL_OPTIONS, ROOF_TYPE_OPTIONS } from './_options.ts';

const DEFAULT_THICKNESS = 0.2;

// ─── 2D ridge / hip / break-line geometry ────────────────────────────────────

interface OBB {
  ridgeAlongX: boolean;
  midSpan: number;
  ridgeMin: number;
  ridgeMax: number;
  spanMin: number;
  spanMax: number;
  span: number;
  ridgeLen: number;
}

function obbOf(vertices: Point[]): OBB {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of vertices) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
  }
  const dx = maxX - minX, dy = maxY - minY;
  const ridgeAlongX = dx >= dy;
  return {
    ridgeAlongX,
    midSpan: ridgeAlongX ? (minY + maxY) / 2 : (minX + maxX) / 2,
    ridgeMin: ridgeAlongX ? minX : minY,
    ridgeMax: ridgeAlongX ? maxX : maxY,
    spanMin: ridgeAlongX ? minY : minX,
    spanMax: ridgeAlongX ? maxY : maxX,
    span: ridgeAlongX ? dy : dx,
    ridgeLen: ridgeAlongX ? dx : dy,
  };
}

/** Build a point from (ridge, span) coords in the OBB's axis-aligned frame. */
function pt(obb: OBB, r: number, s: number): Point {
  return obb.ridgeAlongX ? { x: r, y: s } : { x: s, y: r };
}

interface Arrow { from: Point; to: Point; headTip: Point; headBase1: Point; headBase2: Point }

function arrow(from: Point, to: Point, headSize: number): Arrow {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return { from, to, headTip: to, headBase1: to, headBase2: to };
  }
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const back = { x: to.x - ux * headSize, y: to.y - uy * headSize };
  return {
    from, to,
    headTip: to,
    headBase1: { x: back.x + px * headSize * 0.5, y: back.y + py * headSize * 0.5 },
    headBase2: { x: back.x - px * headSize * 0.5, y: back.y - py * headSize * 0.5 },
  };
}

interface RoofProAnnotations {
  ridges: [Point, Point][];     // solid main ridge / break lines
  hips: [Point, Point][];        // hip lines (corner→ridge)
  breaks: [Point, Point][];      // mansard break lines (dashed)
  arrows: Arrow[];
  labelPos: Point | null;
}

function annotateRoof(facts: RoofFacts): RoofProAnnotations {
  const empty: RoofProAnnotations = { ridges: [], hips: [], breaks: [], arrows: [], labelPos: null };
  if (facts.roofType === 'flat' || facts.slopeDeg <= 0) return empty;
  const obb = obbOf(facts.vertices);
  if (obb.span < 0.5 || obb.ridgeLen < 0.5) return empty;

  const arrowLen = Math.min(obb.span, obb.ridgeLen) * 0.18;
  const arrowHead = Math.min(0.4, arrowLen * 0.4);
  const ridgeMid = (obb.ridgeMin + obb.ridgeMax) / 2;
  const ans: RoofProAnnotations = {
    ridges: [], hips: [], breaks: [], arrows: [],
    labelPos: pt(obb, ridgeMid, obb.midSpan),
  };

  switch (facts.roofType) {
    case 'shed': {
      // Single arrow pointing from spanMin (high) to spanMax (low).
      const r = ridgeMid;
      const from = pt(obb, r, obb.spanMin + obb.span * 0.4);
      const to = pt(obb, r, obb.spanMin + obb.span * 0.4 + arrowLen);
      ans.arrows.push(arrow(from, to, arrowHead));
      break;
    }
    case 'gable': {
      ans.ridges.push([pt(obb, obb.ridgeMin, obb.midSpan), pt(obb, obb.ridgeMax, obb.midSpan)]);
      // Two arrows: from ridge mid outward to either side.
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan - arrowLen), arrowHead));
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan + arrowLen), arrowHead));
      break;
    }
    case 'hip': {
      const inset = Math.min(obb.span / 2, obb.ridgeLen / 2 - 0.001);
      const r0 = obb.ridgeMin + inset;
      const r1 = obb.ridgeMax - inset;
      ans.ridges.push([pt(obb, r0, obb.midSpan), pt(obb, r1, obb.midSpan)]);
      // Four hip lines: each OBB corner → nearest ridge endpoint.
      ans.hips.push([pt(obb, obb.ridgeMin, obb.spanMin), pt(obb, r0, obb.midSpan)]);
      ans.hips.push([pt(obb, obb.ridgeMin, obb.spanMax), pt(obb, r0, obb.midSpan)]);
      ans.hips.push([pt(obb, obb.ridgeMax, obb.spanMin), pt(obb, r1, obb.midSpan)]);
      ans.hips.push([pt(obb, obb.ridgeMax, obb.spanMax), pt(obb, r1, obb.midSpan)]);
      // Arrows on the two main slopes (span direction) at ridge mid.
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan - arrowLen), arrowHead));
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan + arrowLen), arrowHead));
      break;
    }
    case 'mansard': {
      // Inner rectangle (upper flat plateau) inset by band·span on each side.
      const band = 0.3;
      const innerSpanMin = obb.spanMin + obb.span * band;
      const innerSpanMax = obb.spanMax - obb.span * band;
      const innerRidgeMin = obb.ridgeMin + obb.span * band;
      const innerRidgeMax = obb.ridgeMax - obb.span * band;
      ans.breaks.push([pt(obb, obb.ridgeMin, innerSpanMin), pt(obb, obb.ridgeMax, innerSpanMin)]);
      ans.breaks.push([pt(obb, obb.ridgeMin, innerSpanMax), pt(obb, obb.ridgeMax, innerSpanMax)]);
      ans.breaks.push([pt(obb, innerRidgeMin, obb.spanMin), pt(obb, innerRidgeMin, obb.spanMax)]);
      ans.breaks.push([pt(obb, innerRidgeMax, obb.spanMin), pt(obb, innerRidgeMax, obb.spanMax)]);
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan - arrowLen), arrowHead));
      ans.arrows.push(arrow(pt(obb, ridgeMid, obb.midSpan), pt(obb, ridgeMid, obb.midSpan + arrowLen), arrowHead));
      break;
    }
  }
  return ans;
}

export interface RoofFacts {
  id: string;
  vertices: Point[];
  thickness: number;
  baseY: number;
  roofType: string;
  slopeDeg: number;
  material: string;
  /** Polygon-opening holes hosted on this roof (skylights, smoke vents, etc.). */
  holes: Point[][];
}

export const roofModule: ElementModule<RoofFacts> = {
  table: 'roof',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'ro',
  csvHeaders: ['number', 'base_offset', 'material', 'roof_type', 'slope', 'thickness'],
  defaults: { base_offset: '0', material: 'concrete', roof_type: 'flat', slope: '0', thickness: `${DEFAULT_THICKNESS}` },
  drawingFields: [
    { key: 'roof_type', label: 'Type', type: 'select', options: ROOF_TYPE_OPTIONS },
    { key: 'slope', label: 'Slope', type: 'number', unit: '°', min: 0, max: 60, step: 5 },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Roofs', color: '#8d6e63', icon: '△', order: 7.5 },
  renderZIndex: 19,

  geometry(el: CanonicalElement, ctx: GeometryContext): RoofFacts | null {
    if (el.geometry !== 'polygon') return null;
    const p = el as PolygonElement;
    if (p.vertices.length < 3) return null;
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    const thickness = parseFloat(p.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
    const slopeDeg = parseFloat(p.attrs.slope || '0') || 0;

    // Polygon-opening holes from opening elements hosted on this roof.
    const holes: Point[][] = [];
    for (const child of ctx.hostedOf(p.id)) {
      if (child.tableName !== 'opening') continue;
      if (child.geometry !== 'polygon') continue;
      const v = (child as PolygonElement).vertices;
      if (v.length >= 3) holes.push(v);
    }

    return {
      id: p.id,
      vertices: p.vertices,
      thickness,
      baseY: ctx.levelElevation + baseOffset,
      roofType: p.attrs.roof_type || 'flat',
      slopeDeg,
      material: p.attrs.material || 'concrete',
      holes,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    const lineColor = drawCtx.selected ? '#3a7bff' : '#5d4037';
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    const ann = annotateRoof(facts);
    const labelPos = ann.labelPos;
    const fontSize = 0.25;
    return (
      <g data-id={facts.id}>
        <polygon
          points={points}
          fill="rgba(141,110,99,0.05)"
          stroke={stroke}
          strokeWidth={0.025}
          data-id={facts.id}
        />
        {ann.ridges.map(([a, b], i) => (
          <line key={`r${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={lineColor} strokeWidth={0.025} strokeLinecap="round" />
        ))}
        {ann.hips.map(([a, b], i) => (
          <line key={`h${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={lineColor} strokeWidth={0.02} strokeLinecap="round" />
        ))}
        {ann.breaks.map(([a, b], i) => (
          <line key={`b${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={lineColor} strokeWidth={0.02} strokeDasharray="0.12 0.06" />
        ))}
        {ann.arrows.map((ar, i) => (
          <g key={`a${i}`}>
            <line x1={ar.from.x} y1={ar.from.y} x2={ar.to.x} y2={ar.to.y}
              stroke={lineColor} strokeWidth={0.02} />
            <polygon
              points={`${ar.headTip.x},${ar.headTip.y} ${ar.headBase1.x},${ar.headBase1.y} ${ar.headBase2.x},${ar.headBase2.y}`}
              fill={lineColor} stroke="none" />
          </g>
        ))}
        {labelPos && facts.slopeDeg > 0 && (
          <text
            x={labelPos.x} y={labelPos.y}
            textAnchor="middle" dominantBaseline="central"
            fontSize={fontSize} fontFamily="Inter, sans-serif" fontWeight={500}
            fill={lineColor}
            transform={`translate(${labelPos.x},${labelPos.y}) scale(1,-1) translate(${-labelPos.x},${-labelPos.y})`}
          >
            {`${facts.slopeDeg}°`}
          </text>
        )}
        {facts.holes.map((hole, i) => (
          <polygon
            key={`hole${i}`}
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
  },

  draw3D(facts, drawCtx): ReactNode {
    let geo: BufferGeometry | null = createRoofGeometry({
      kind: 'extrude',
      vertices: facts.vertices,
      baseY: facts.baseY,
      height: facts.thickness,
      roofType: facts.roofType,
      slopeDeg: facts.slopeDeg,
    });
    if (!geo) return null;

    // CSG-cut roof openings (skylights etc.) using the same applyOpenings helper
    // slab uses. createRoofGeometry already includes pitch in the geometry; the
    // hole prism is extruded vertically and intersected with that.
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
        tableName: 'roof',
        footprint: facts.vertices,
        extrudeDirection: { x: 0, y: 1, z: 0 },
        height: facts.thickness,
        origin: { x: 0, y: facts.baseY, z: 0 },
        material: resolveBimMaterial(facts.material, 'roof'),
        openings: polyOpenings,
      };
      const cut = applyOpenings(geo, fakePrim);
      if (cut !== geo) geo.dispose();
      geo = cut;
    }

    const material = getBimMaterial(resolveBimMaterial(facts.material, 'roof'));
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
          <meshStandardMaterial attach="material" color="#06b6d4"
            transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
        )}
      </mesh>
    );
  },

  bbox(facts) {
    if (facts.vertices.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.vertices) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(roofModule);
