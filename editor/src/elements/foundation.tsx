/**
 * Foundation — mixed-geometry element (spec: structure/foundation.yaml):
 *   - point   → isolated pad footing, `width` × `length` (kind pad, default)
 *               or a pile, diameter `width` / `width` × `length` (kind pile)
 *   - line    → strip footing, `width` across the centre line (kind strip)
 *   - polygon → raft / mat (kind raft, default), pile cap or irregular pad
 * The top face is level + base_offset; the body hangs down by `thickness`.
 * Foundations sit below the plan cut, so plans draw them dashed.
 */
import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry, Path } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type {
  CanonicalElement, PointElement, LineElement, PolygonElement, Point,
} from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import {
  BASE_OFFSET_FIELD, FOUNDATION_KIND_OPTIONS, MATERIAL_GRADE_FIELD, MATERIAL_OPTIONS,
} from './_options.ts';
import { PlanTag, tagText } from './_planTag.tsx';

const DEFAULT_THICKNESS = 0.4;
const DEFAULT_PAD_SIZE = 1.5;
const DEFAULT_PILE_DIAMETER = 0.6;
const DEFAULT_STRIP_WIDTH = 0.8;

export type FoundationKind = 'pad' | 'strip' | 'raft' | 'pile_cap' | 'pile';

/** Foundation kind from the CSV `kind`, else the default for the geometry. */
export function foundationKind(el: CanonicalElement): FoundationKind {
  const k = el.attrs.kind;
  if (k === 'pad' || k === 'strip' || k === 'raft' || k === 'pile_cap' || k === 'pile') return k;
  if (el.geometry === 'point') return 'pad';
  if (el.geometry === 'line' || el.geometry === 'spatial_line') return 'strip';
  return 'raft';
}

interface FoundationBase {
  id: string;
  kind: FoundationKind;
  thickness: number;
  /** Bottom of the body (world Y) = top − thickness. */
  baseY: number;
  material: string;
  number: string;
}

export type FoundationFacts =
  | (FoundationBase & {
      form: 'point';
      position: Point;
      width: number;
      depth: number;
      /** Pile with no `length`: a round section of diameter `width`. */
      round: boolean;
      rotationDeg: number;
    })
  | (FoundationBase & {
      form: 'line';
      start: Point;
      end: Point;
      strokeWidth: number;
      footprint2D: Point[];
    })
  | (FoundationBase & {
      form: 'polygon';
      vertices: Point[];
      holes: Point[][];
    });

const num = (v: string | undefined) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

export const foundationModule: ElementModule<FoundationFacts> = {
  table: 'foundation',
  discipline: 'structure',
  archetype: 'surface',
  geometryType: 'mixed',
  prefix: 'f',
  csvHeaders: ['number', 'kind', 'base_offset', 'thickness', 'width', 'length', 'material', 'material_grade'],
  defaults: { base_offset: '0', material: 'concrete', thickness: `${DEFAULT_THICKNESS}` },
  pointSizeAttrs: ['width', 'length'],
  lineWidthAttr: 'width',
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.1, step: 0.1 },
    { key: 'length', label: 'Length', type: 'number', unit: 'm', min: 0.1, step: 0.1 },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
    { key: 'kind', label: 'Kind', type: 'select', options: FOUNDATION_KIND_OPTIONS },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    MATERIAL_GRADE_FIELD,
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Foundations', color: '#8d6e63', icon: '▨', order: 8.1 },
  renderZIndex: 22,
  toolbarVariants: [
    {
      id: 'isolated', label: 'layer.isolated_foundation', icon: '◼', iconName: 'isolated_foundation', placementType: 'free_point',
      defaults: { kind: 'pad', width: `${DEFAULT_PAD_SIZE}`, length: `${DEFAULT_PAD_SIZE}`, thickness: '0.5' },
      fields: ['width', 'length', 'thickness', 'material', 'base_offset'],
    },
    {
      id: 'strip', label: 'layer.strip_foundation', icon: '▬', iconName: 'strip_foundation', placementType: 'free_line',
      defaults: { kind: 'strip', width: `${DEFAULT_STRIP_WIDTH}`, thickness: '0.4' },
      fields: ['width', 'thickness', 'material', 'base_offset'],
    },
    {
      id: 'raft', label: 'layer.raft_foundation', icon: '▢', iconName: 'raft_foundation', placementType: 'free_polygon',
      defaults: { kind: 'raft', thickness: '0.8' },
      fields: ['thickness', 'material', 'base_offset'],
    },
    {
      id: 'pile_cap', label: 'layer.pile_cap_foundation', icon: '▭', iconName: 'pile_cap_foundation', placementType: 'free_polygon',
      defaults: { kind: 'pile_cap', thickness: '1.0' },
      fields: ['thickness', 'material', 'base_offset'],
    },
    {
      id: 'pile', label: 'layer.pile_foundation', icon: '●', iconName: 'pile_foundation', placementType: 'free_point',
      defaults: { kind: 'pile', width: `${DEFAULT_PILE_DIAMETER}`, length: '', thickness: '15' },
      fields: ['width', 'thickness', 'material', 'base_offset'],
      fieldLabels: { width: 'Diameter', thickness: 'Pile Length' },
    },
  ],

  geometry(el: CanonicalElement, ctx: GeometryContext): FoundationFacts | null {
    const baseOffset = parseFloat(el.attrs.base_offset || '0') || 0;
    const thickness = num(el.attrs.thickness) || DEFAULT_THICKNESS;
    // Top face at level + base_offset; the body hangs down by thickness.
    const base = {
      id: el.id,
      kind: foundationKind(el),
      thickness,
      baseY: ctx.levelElevation + baseOffset - thickness,
      material: el.attrs.material || 'concrete',
      number: tagText(el.attrs),
    };

    if (el.geometry === 'point') {
      const p = el as PointElement;
      const isPile = base.kind === 'pile';
      const fallback = isPile ? DEFAULT_PILE_DIAMETER : DEFAULT_PAD_SIZE;
      // CSV width/length are the source of truth (parse maps them onto the
      // point's width/height too, which drives selection + resize).
      const width = num(p.attrs.width) || (isPile ? fallback : p.width) || fallback;
      const lengthAttr = num(p.attrs.length);
      const round = isPile && !lengthAttr;
      const depth = round ? width : (lengthAttr || (isPile ? width : p.height) || width);
      return {
        ...base, form: 'point',
        position: p.position,
        width, depth, round,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
      };
    }
    if (el.geometry === 'line' || el.geometry === 'spatial_line') {
      const ln = el as LineElement;
      const dx = ln.end.x - ln.start.x;
      const dy = ln.end.y - ln.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) return null;
      // Strip width is the CSV `width` (not `thickness`, which is the depth).
      const w = num(ln.attrs.width) || ln.strokeWidth || DEFAULT_STRIP_WIDTH;
      const nx = -dy / len, ny = dx / len;
      const hw = w / 2;
      const footprint2D: Point[] = [
        { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
        { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
        { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
        { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
      ];
      return {
        ...base, form: 'line',
        start: ln.start, end: ln.end,
        strokeWidth: w, footprint2D,
      };
    }
    if (el.geometry === 'polygon') {
      const p = el as PolygonElement;
      if (p.vertices.length < 3) return null;
      return { ...base, form: 'polygon', vertices: p.vertices, holes: p.holes ?? [] };
    }
    return null;
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#6d4c41');
    const fill = 'rgba(141,110,99,0.10)';
    // Below the cut plane: dashed outline (hidden-line convention).
    const dash = '0.16 0.08';
    const sw = 0.025;
    const tag = drawCtx.showNumbers && facts.number;

    if (facts.form === 'point') {
      const w = facts.width, h = facts.depth;
      return (
        <g data-id={facts.id}>
          <g transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`}>
            {facts.round ? (
              <ellipse cx={0} cy={0} rx={w / 2} ry={h / 2}
                fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
            ) : (
              <rect x={-w / 2} y={-h / 2} width={w} height={h}
                fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
            )}
            {facts.kind === 'pile' && (
              // Pile centre mark.
              <path d={`M ${-w * 0.25} 0 L ${w * 0.25} 0 M 0 ${-h * 0.25} L 0 ${h * 0.25}`}
                stroke={stroke} strokeWidth={sw * 0.7} />
            )}
          </g>
          {tag && <PlanTag x={facts.position.x + w / 2 + 0.05} y={facts.position.y - h / 2 - 0.2} text={facts.number} color={stroke} />}
        </g>
      );
    }
    if (facts.form === 'line') {
      const [a, b, c, d] = facts.footprint2D;
      const angle = Math.atan2(facts.end.y - facts.start.y, facts.end.x - facts.start.x) * 180 / Math.PI;
      return (
        <g data-id={facts.id}>
          <polygon points={facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ')} fill={fill} stroke="none" />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
          <line x1={c.x} y1={c.y} x2={d.x} y2={d.y} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
          <line x1={facts.start.x} y1={facts.start.y} x2={facts.end.x} y2={facts.end.y}
            stroke={stroke} strokeWidth={0.012} strokeDasharray="0.4 0.08 0.05 0.08" opacity={0.6} />
          {tag && <PlanTag x={(facts.start.x + facts.end.x) / 2} y={(facts.start.y + facts.end.y) / 2}
            text={facts.number} color={stroke} angleDeg={angle} />}
        </g>
      );
    }
    // polygon (raft / pile cap / irregular pad); holes as sub-paths
    const ringPath = (r: Point[]) => `M ${r.map(v => `${v.x},${v.y}`).join(' L ')} Z`;
    const d = [facts.vertices, ...facts.holes].map(ringPath).join(' ');
    const c = centroid(facts.vertices);
    return (
      <g data-id={facts.id}>
        <path d={d} fillRule="evenodd" fill={fill} stroke={stroke}
          strokeWidth={facts.kind === 'pile_cap' ? sw * 1.4 : sw} strokeDasharray={dash} />
        {tag && <PlanTag x={c.x} y={c.y} text={facts.number} color={stroke} />}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'foundation'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const highlight = isHL ? (
      <meshStandardMaterial attach="material" color="#06b6d4"
        transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
    ) : null;

    if (facts.form === 'point') {
      // three.js rotation.y = θ turns plan +X to (cos θ, sin θ): spec rotation is CCW.
      const rotY = (facts.rotationDeg * Math.PI) / 180;
      return (
        <mesh
          position={[facts.position.x, facts.baseY + facts.thickness / 2, -facts.position.y]}
          rotation={[0, rotY, 0]}
          scale={[facts.width, facts.thickness, facts.depth]}
          material={isHL ? undefined : material}
          castShadow receiveShadow
          userData={{ elementId: facts.id }}
        >
          {facts.round
            ? <cylinderGeometry args={[0.5, 0.5, 1, 24]} />
            : <boxGeometry args={[1, 1, 1]} />}
          {highlight}
        </mesh>
      );
    }

    // line + polygon: extrude the footprint up by thickness from baseY (= top − thickness)
    const verts = facts.form === 'line' ? facts.footprint2D : facts.vertices;
    const shape = new Shape();
    shape.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) shape.lineTo(verts[i].x, verts[i].y);
    shape.closePath();
    if (facts.form === 'polygon') {
      for (const hole of facts.holes) {
        const path = new Path();
        path.moveTo(hole[0].x, hole[0].y);
        for (let i = 1; i < hole.length; i++) path.lineTo(hole[i].x, hole[i].y);
        path.closePath();
        shape.holes.push(path);
      }
    }
    const geo = new ExtrudeGeometry(shape, { depth: facts.thickness, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, facts.baseY, 0);
    return (
      <mesh
        geometry={geo}
        material={isHL ? undefined : material}
        castShadow receiveShadow
        userData={{ elementId: facts.id }}
      >
        {highlight}
      </mesh>
    );
  },

  bbox(facts) {
    if (facts.form === 'point') {
      return {
        x: facts.position.x - facts.width / 2,
        y: facts.position.y - facts.depth / 2,
        w: facts.width, h: facts.depth,
      };
    }
    const verts = facts.form === 'line' ? facts.footprint2D : facts.vertices;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of verts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

function centroid(vs: Point[]): Point {
  let x = 0, y = 0;
  for (const v of vs) { x += v.x; y += v.y; }
  return { x: x / vs.length, y: y / vs.length };
}

registerElement(foundationModule);
