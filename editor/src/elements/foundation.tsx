/**
 * Foundation — mixed-geometry element. Can be:
 *   - point   → isolated/pad footing  (box)
 *   - line    → strip footing         (stroked line strip)
 *   - polygon → raft / mat foundation (extruded polygon, like slab)
 *
 * Dispatches per geometry kind in both geometry() and draw2D/3D.
 */
import type { ReactNode } from 'react';
import { Shape, ExtrudeGeometry } from 'three';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type {
  CanonicalElement, PointElement, LineElement, PolygonElement, Point,
} from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';

const DEFAULT_THICKNESS = 0.4;

export type FoundationFacts =
  | {
      id: string;
      kind: 'point';
      position: Point;
      width: number;
      depth: number;
      rotationDeg: number;
      thickness: number;
      baseY: number;
      material: string;
    }
  | {
      id: string;
      kind: 'line';
      start: Point;
      end: Point;
      strokeWidth: number;
      footprint2D: Point[];
      thickness: number;
      baseY: number;
      material: string;
    }
  | {
      id: string;
      kind: 'polygon';
      vertices: Point[];
      thickness: number;
      baseY: number;
      material: string;
    };

export const foundationModule: ElementModule<FoundationFacts> = {
  table: 'foundation',
  discipline: 'structure',
  archetype: 'surface',
  geometryType: 'mixed',
  prefix: 'f',
  csvHeaders: ['number', 'base_offset', 'thickness', 'width', 'length', 'material'],
  defaults: { base_offset: '0', material: 'concrete', thickness: `${DEFAULT_THICKNESS}` },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.1, step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Foundations', color: '#8d6e63', icon: '▨', order: 8.1 },
  renderZIndex: 22,

  geometry(el: CanonicalElement, ctx: GeometryContext): FoundationFacts | null {
    const baseOffset = parseFloat(el.attrs.base_offset || '0') || 0;
    const thickness = parseFloat(el.attrs.thickness || `${DEFAULT_THICKNESS}`) || DEFAULT_THICKNESS;
    // Foundation top is at level+base_offset; the slab body extrudes DOWN from there,
    // i.e. base of mesh = top − thickness.
    const baseY = ctx.levelElevation + baseOffset - thickness;
    const material = el.attrs.material || 'concrete';

    if (el.geometry === 'point') {
      const p = el as PointElement;
      return {
        id: p.id, kind: 'point',
        position: p.position,
        width: p.width,
        depth: p.height,
        rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
        thickness, baseY, material,
      };
    }
    if (el.geometry === 'line' || el.geometry === 'spatial_line') {
      const ln = el as LineElement;
      const dx = ln.end.x - ln.start.x;
      const dy = ln.end.y - ln.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) return null;
      const nx = -dy / len, ny = dx / len;
      const hw = ln.strokeWidth / 2;
      const footprint2D: Point[] = [
        { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
        { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
        { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
        { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
      ];
      return {
        id: ln.id, kind: 'line',
        start: ln.start, end: ln.end,
        strokeWidth: ln.strokeWidth, footprint2D,
        thickness, baseY, material,
      };
    }
    if (el.geometry === 'polygon') {
      const p = el as PolygonElement;
      if (p.vertices.length < 3) return null;
      return {
        id: p.id, kind: 'polygon',
        vertices: p.vertices,
        thickness, baseY, material,
      };
    }
    return null;
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#8d6e63';
    if (facts.kind === 'point') {
      return (
        <g data-id={facts.id}
          transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`}>
          <rect x={-facts.width / 2} y={-facts.depth / 2} width={facts.width} height={facts.depth}
            fill="rgba(141,110,99,0.08)" stroke={stroke} strokeWidth={0.025} />
        </g>
      );
    }
    if (facts.kind === 'line') {
      const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
      return <polygon points={points} fill="rgba(141,110,99,0.08)" stroke={stroke} strokeWidth={0.025} data-id={facts.id} />;
    }
    // polygon
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    return <polygon points={points} fill="rgba(141,110,99,0.08)" stroke={stroke} strokeWidth={0.025} data-id={facts.id} />;
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'foundation'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const highlight = isHL ? (
      <meshStandardMaterial attach="material" color="#06b6d4"
        transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
    ) : null;

    if (facts.kind === 'point') {
      const rotY = -(facts.rotationDeg * Math.PI) / 180;
      return (
        <mesh
          position={[facts.position.x, facts.baseY + facts.thickness / 2, -facts.position.y]}
          rotation={[0, rotY, 0]}
          scale={[facts.width, facts.thickness, facts.depth]}
          material={isHL ? undefined : material}
          userData={{ elementId: facts.id }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {highlight}
        </mesh>
      );
    }

    // line + polygon: extrude footprint upward by thickness
    const verts = facts.kind === 'line' ? facts.footprint2D : facts.vertices;
    const shape = new Shape();
    shape.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) shape.lineTo(verts[i].x, verts[i].y);
    shape.closePath();
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
    if (facts.kind === 'point') {
      return {
        x: facts.position.x - facts.width / 2,
        y: facts.position.y - facts.depth / 2,
        w: facts.width, h: facts.depth,
      };
    }
    const verts = facts.kind === 'line' ? facts.footprint2D : facts.vertices;
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

registerElement(foundationModule);
