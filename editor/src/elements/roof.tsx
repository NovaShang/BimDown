/**
 * Roof — surface archetype. A footprint roof: each footprint edge may define
 * a slope (`edge_slopes`, else implied by roof_type + slope), the roof planes
 * come from geometry/roofSolver.ts (exact ridges, hips and valleys for any
 * footprint), plus mansard decks and extrusion roofs.
 * 2D: outline, ridge / hip / valley lines, a slope arrow per roof plane.
 * 3D: a sloped slab (underside on the planes) with openings cut.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, PlacementContext } from './archetypes.ts';
import { resolveHeight } from '../three/utils/elementTo3D.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PolygonElement, Point } from '../model/elements.ts';
import { roofGeometryFromSolution } from '../three/utils/roofGeometry.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, ROOF_TYPE_OPTIONS, YES_NO_OPTIONS } from './_options.ts';
import { roofSolution } from '../geometry/attach.ts';
import {
  centroid, signedArea, verticalThickness, roofInputFor, type RoofSolution, type RoofLine,
} from '../geometry/roofSolver.ts';
import { isShaft } from '../model/crossLevel.ts';
import { shaftHolesFor } from './_shafts.ts';
import { ShaftCross } from './_slabShared.tsx';
import RoofEdgesPanel from '../components/RoofEdgesPanel.tsx';

const DEFAULT_THICKNESS = 0.2;

export interface RoofArrow { from: Point; to: Point; label: string }

export interface RoofFacts {
  id: string;
  vertices: Point[];
  thickness: number;
  /** Underside elevation at the eaves (level + base_offset). */
  baseY: number;
  roofType: string;
  slopeDeg: number;
  material: string;
  /** Polygon openings hosted on this roof (skylights, dormers), shafts and inner rings. */
  holes: Point[][];
  shaftHoles: Point[][];
  /** Effective slope per footprint edge (0 = not slope-defining). */
  edgeSlopes: number[];
  solution: RoofSolution;
  /** Vertical slab thickness (thickness / cos slope). */
  vThick: number;
}

const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);
const DEFAULT_STOREY = 3.0;

/** A new roof sits on top of the walls: the highest wall top on this level
 *  (relative to it), else the next level up, else one default storey. */
export function defaultRoofBaseOffset({ elements, levels, levelId }: PlacementContext): number {
  const elevations = new Map(levels.map(l => [l.id, l.elevation]));
  const elevation = elevations.get(levelId) ?? 0;
  let top = -Infinity;
  for (const el of elements.values()) {
    if (!WALL_TABLES.has(el.tableName)) continue;
    const { height, baseOffset } = resolveHeight(el.attrs, elevation, elevations, DEFAULT_STOREY);
    top = Math.max(top, baseOffset + height);
  }
  if (top === -Infinity) {
    const above = levels.filter(l => l.elevation > elevation).map(l => l.elevation);
    top = above.length > 0 ? Math.min(...above) - elevation : DEFAULT_STOREY;
  }
  return Number(top.toFixed(3));
}

/** Slope label: degrees, or percent for drainage falls under 5°. */
export function slopeLabel(deg: number): string {
  if (deg < 5) return `${(Math.tan((deg * Math.PI) / 180) * 100).toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(deg * 10) / 10}°`;
}

/** One down-slope arrow per sloped roof plane, in the middle of its largest piece. */
export function roofArrows(sol: RoofSolution): RoofArrow[] {
  const best = new Map<number, { area: number; poly: Point[] }>();
  for (const pc of sol.pieces) {
    const pl = sol.planes[pc.plane];
    if (Math.hypot(pl.a, pl.b) < 1e-6) continue;
    const area = Math.abs(signedArea(pc.poly));
    const cur = best.get(pc.plane);
    if (!cur || area > cur.area) best.set(pc.plane, { area, poly: pc.poly });
  }
  const out: RoofArrow[] = [];
  for (const [plane, { area, poly }] of best) {
    if (area < 0.05) continue;
    const pl = sol.planes[plane];
    const g = Math.hypot(pl.a, pl.b);
    const ux = -pl.a / g, uy = -pl.b / g; // downhill
    const c = centroid(poly);
    const len = Math.max(0.3, Math.min(1.2, Math.sqrt(area) * 0.35));
    out.push({
      from: { x: c.x - ux * len / 2, y: c.y - uy * len / 2 },
      to: { x: c.x + ux * len / 2, y: c.y + uy * len / 2 },
      label: slopeLabel((Math.atan(g) * 180) / Math.PI),
    });
  }
  return out;
}

/** Roof holes: hosted polygon openings, shafts through its body, inner rings. */
function roofHoles(p: PolygonElement, ctx: GeometryContext, baseY: number, top: number): { holes: Point[][]; shafts: Point[][] } {
  const holes: Point[][] = [...(p.holes ?? [])];
  for (const child of ctx.hostedOf(p.id)) {
    if (child.tableName !== 'opening' || child.geometry !== 'polygon' || isShaft(child)) continue;
    const v = (child as PolygonElement).vertices;
    if (v.length >= 3) holes.push(v);
  }
  const shafts = shaftHolesFor(ctx, baseY, top, p.vertices);
  return { holes: [...holes, ...shafts], shafts };
}

const arrowHead = (a: Point, b: Point, size: number): string => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = b.x - ux * size, by = b.y - uy * size;
  return `${b.x},${b.y} ${bx - uy * size * 0.45},${by + ux * size * 0.45} ${bx + uy * size * 0.45},${by - ux * size * 0.45}`;
};

function lineStyle(l: RoofLine): { width: number; dash?: string } {
  if (l.kind === 'ridge') return { width: 0.03 };
  if (l.kind === 'hip') return { width: 0.022 };
  return { width: 0.022, dash: '0.15 0.07' };
}

export const roofModule: ElementModule<RoofFacts> = {
  table: 'roof',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'ro',
  csvHeaders: ['number', 'base_offset', 'material', 'roof_type', 'slope', 'edge_slopes', 'profile', 'thickness'],
  defaults: { base_offset: '0', material: 'concrete', roof_type: 'flat', slope: '0', thickness: `${DEFAULT_THICKNESS}` },
  drawingFields: [
    { key: 'roof_type', label: 'Roof Type', type: 'select', options: ROOF_TYPE_OPTIONS },
    { key: 'slope', label: 'Slope', type: 'number', unit: '°', min: 0, max: 60, step: 5 },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.005 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  placementDefaults: ctx => ({ base_offset: String(defaultRoofBaseOffset(ctx)) }),
  layerStyle: { displayName: 'Roofs', color: '#8d6e63', icon: '△', order: 7.5 },
  renderZIndex: 19,
  propertyPanel: RoofEdgesPanel,
  // Sketch the footprint, or pick walls: their outline + overhang, walls attached.
  toolbarVariants: [
    { id: 'sketch', label: 'layer.roof_sketch', icon: '△', iconName: 'roof', placementType: 'free_polygon' },
    {
      id: 'by_walls', label: 'layer.roof_by_walls', icon: '⌂', iconName: 'roof', placementType: 'pick',
      defaults: { roof_type: 'hip', slope: '30', __overhang: '0.5', __attach: 'yes' },
      fields: ['roof_type', 'slope', 'thickness', 'material'],
      extraFields: [
        { key: '__overhang', label: 'Overhang', type: 'number', unit: 'm', min: 0, step: 0.1 },
        { key: '__attach', label: 'Attach walls', type: 'select', options: YES_NO_OPTIONS },
      ],
    },
    // Dormer: click a sloped roof plane; opening + small roof + walls in one step (tools/dormerTool.ts).
    {
      id: 'dormer', label: 'layer.roof_dormer', icon: '⌂', iconName: 'roof', placementType: 'pick',
      defaults: { __dormer_kind: 'gable', __dormer_width: '1.6', __dormer_front: '1.3', slope: '35', __overhang: '0.2', material: 'wood' },
      fields: ['slope', 'thickness', 'material'],
      extraFields: [
        { key: '__dormer_kind', label: 'Dormer', type: 'select', options: [{ value: 'gable', label: 'Gable' }, { value: 'shed', label: 'Shed' }] },
        { key: '__dormer_width', label: 'Width', type: 'number', unit: 'm', min: 0.6, step: 0.1 },
        { key: '__dormer_front', label: 'Front Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
        { key: '__overhang', label: 'Overhang', type: 'number', unit: 'm', min: 0, step: 0.1 },
      ],
    },
  ],

  geometry(el: CanonicalElement, ctx: GeometryContext): RoofFacts | null {
    if (el.geometry !== 'polygon') return null;
    const p = el as PolygonElement;
    if (p.vertices.length < 3) return null;
    const baseOffset = parseFloat(p.attrs.base_offset || '0') || 0;
    const thickness = parseFloat(p.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
    const solution = roofSolution(p);
    const vThick = verticalThickness(thickness, solution.maxSlopeDeg);
    const baseY = ctx.levelElevation + baseOffset;
    const { holes, shafts } = roofHoles(p, ctx, baseY, baseY + solution.maxRise + vThick);
    const input = roofInputFor(p.vertices, p.attrs);
    return {
      id: p.id,
      vertices: p.vertices,
      thickness,
      baseY,
      roofType: p.attrs.roof_type || 'flat',
      slopeDeg: solution.maxSlopeDeg,
      material: p.attrs.material || 'concrete',
      holes,
      shaftHoles: shafts,
      edgeSlopes: input.edgeSlopes.length === p.vertices.length ? input.edgeSlopes : p.vertices.map(() => 0),
      solution,
      vThick,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    const lineColor = drawCtx.selected ? '#3a7bff' : '#5d4037';
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    const arrows = roofArrows(facts.solution);
    const fontSize = 0.22;
    const label = (at: Point, text: string, key: string, color = lineColor, weight = 500) => (
      <text key={key}
        x={at.x} y={at.y}
        textAnchor="middle" dominantBaseline="central"
        fontSize={fontSize} fontFamily="Inter, sans-serif" fontWeight={weight}
        fill={color} pointerEvents="none"
        transform={`translate(${at.x},${at.y}) scale(1,-1) translate(${-at.x},${-at.y})`}
      >
        {text}
      </text>
    );
    const orient = signedArea(facts.vertices) >= 0 ? 1 : -1;
    return (
      <g data-id={facts.id}>
        <polygon
          points={points}
          fill="rgba(141,110,99,0.05)"
          stroke={stroke}
          strokeWidth={0.025}
          data-id={facts.id}
        />
        {facts.solution.lines.map((l, i) => {
          const st = lineStyle(l);
          return (
            <line key={`l${i}`} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y}
              stroke={lineColor} strokeWidth={st.width} strokeDasharray={st.dash} strokeLinecap="round" />
          );
        })}
        {arrows.map((ar, i) => {
          const head = Math.min(0.22, Math.hypot(ar.to.x - ar.from.x, ar.to.y - ar.from.y) * 0.35);
          const dx = ar.to.x - ar.from.x, dy = ar.to.y - ar.from.y;
          const len = Math.hypot(dx, dy) || 1;
          // Label beside the arrow tail, offset across it.
          const at = { x: ar.from.x - (dy / len) * 0.22, y: ar.from.y + (dx / len) * 0.22 };
          return (
            <g key={`a${i}`} pointerEvents="none">
              <line x1={ar.from.x} y1={ar.from.y} x2={ar.to.x} y2={ar.to.y} stroke={lineColor} strokeWidth={0.018} />
              <polygon points={arrowHead(ar.from, ar.to, head)} fill={lineColor} stroke="none" />
              {label(at, ar.label, `t${i}`)}
            </g>
          );
        })}
        {drawCtx.selected && facts.vertices.map((a, i) => {
          // Edge numbers (as in the properties panel) outside each edge; sloped edges accented.
          const b = facts.vertices[(i + 1) % facts.vertices.length];
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const nx = ((b.y - a.y) / len) * orient, ny = (-(b.x - a.x) / len) * orient;
          const at = { x: (a.x + b.x) / 2 + nx * 0.3, y: (a.y + b.y) / 2 + ny * 0.3 };
          return label(at, String(i + 1), `e${i}`, facts.edgeSlopes[i] > 0 ? '#3a7bff' : '#9e9e9e', 700);
        })}
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
        {facts.shaftHoles.map((hole, i) => <ShaftCross key={`x${i}`} poly={hole} stroke={stroke} />)}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const geo = roofGeometryFromSolution(facts.solution, facts.vertices, facts.baseY, facts.thickness, facts.holes);
    if (!geo) return null;
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

/** Underside elevation of a roof at a plan point (absolute), for callers with facts. */
export function roofUndersideAt(facts: RoofFacts, p: Point): number {
  return facts.baseY + facts.solution.rise(p);
}

registerElement(roofModule);
