/**
 * Railing — spatial-line archetype, dual mode (spec railing.yaml):
 *  - sketched: its own 3D line (standing on a slab top when host_id is a slab);
 *  - on a stair (host_id = stair, side = left | right): CSV only, the path is
 *    derived from the stair's runs and landings (geometry/stair.ts) and
 *    repeats with a multi-storey stair.
 * 2D: rail line with baluster ticks along the path.
 * 3D: top rail + balusters / glass from the railing type (instance overrides).
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';
import { resolvePropertyFields } from './_propertyFields.ts';
import type { DrawingField } from '../model/tableRegistry.ts';
import { findType } from '../model/types/catalog.ts';
import {
  findStair, hostRefOf, lineRailPath, resolveRef, railPlan, repZ, stairAssemblyIn, stairRailPath, stairRepetitionsIn,
  type RailSegment, type RailSide,
} from '../geometry/stair.ts';
import { railingMeshes, type RailStyle } from './_stair3D.tsx';

const DEFAULT_RAILING_HEIGHT = 1.0;
const DEFAULT_BALUSTER_SPACING = 0.12;
const SLAB_HOSTS = new Set(['slab', 'structure_slab']);

const CSV_HEADERS = ['number', 'base_offset', 'start_z', 'end_z', 'height', 'baluster_spacing', 'material', 'host_id', 'side'];
const DRAWING_FIELDS: DrawingField[] = [
  { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
  BASE_OFFSET_FIELD,
];

export interface RailingFacts {
  id: string;
  /** First / last point of the path (plan) and their walking-surface Z (level-relative). */
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  height: number;
  baseY: number;
  material: string;
  horLen: number;
  angle: number;
  /** Path per storey repetition (one entry unless hosted on a multi-storey stair). */
  paths: RailSegment[][];
  /** Plan polyline of the base path. */
  plan: Point[];
  style: RailStyle;
  host: 'stair' | 'slab' | null;
  side?: RailSide;
}

const num = (s: string | undefined, fallback: number): number => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Height, rail and infill: instance values (type-resolved in memory) over the type's type-only fields. */
export function railingStyle(attrs: Record<string, string>, typeValues: Record<string, string> = {}): RailStyle {
  const infill = typeValues.infill === 'glass' || typeValues.infill === 'none' ? typeValues.infill : 'balusters';
  return {
    height: num(attrs.height, num(typeValues.height, DEFAULT_RAILING_HEIGHT)),
    railShape: typeValues.top_rail_shape === 'rect' ? 'rect' : 'round',
    railSize: num(typeValues.top_rail_size, 0.05),
    infill,
    balusterSpacing: num(attrs.baluster_spacing, num(typeValues.baluster_spacing, DEFAULT_BALUSTER_SPACING)),
    balusterSize: num(typeValues.baluster_size, 0.025),
  };
}

export const railingModule: ElementModule<RailingFacts> = {
  table: 'railing',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'rl',
  hostType: 'stair',
  hostTables: ['stair', 'slab', 'structure_slab'],
  dualMode: true,
  csvHeaders: CSV_HEADERS,
  defaults: { base_offset: '0', start_z: '0', end_z: '0', height: '1.0' },
  drawingFields: DRAWING_FIELDS,
  propertyFields: resolvePropertyFields(CSV_HEADERS, [
    ...DRAWING_FIELDS,
    { key: 'baluster_spacing', label: 'Baluster Spacing', type: 'number', unit: 'm', min: 0.05, step: 0.01 },
    { key: 'side', label: 'Side', type: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
  ]),
  layerStyle: { displayName: 'Railings', color: '#546e7a', icon: '┃', order: 9.2 },
  renderZIndex: 32,
  supportsArc: false,

  geometry(el: CanonicalElement, ctx: GeometryContext): RailingFacts | null {
    const t = findType(ctx.projectTypes(), el.attrs.type_id);
    const style = railingStyle(el.attrs, t && t.table === 'railing_type' ? t.values : {});
    const material = el.attrs.material || t?.values.material || 'steel';
    const hostRef = hostRefOf(el);
    const stair = findStair(ctx, hostRef, el.id);
    let paths: RailSegment[][];
    let host: RailingFacts['host'] = null;
    let side: RailSide | undefined;
    if (stair) {
      host = 'stair';
      side = el.attrs.side === 'right' ? 'right' : 'left';
      const base = stairRailPath(stairAssemblyIn(ctx, stair), side);
      if (base.length === 0) return null;
      paths = stairRepetitionsIn(stair, ctx).map(rep => base.map(s => ({
        a: { ...s.a, z: repZ(rep, s.a.z) },
        b: { ...s.b, z: repZ(rep, s.b.z) },
        run: s.run && { ...s.run, startZ: repZ(rep, s.run.startZ), riser: s.run.riser * rep.scale },
      })));
    } else {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
      const ln = el as LineElement;
      if (Math.hypot(ln.end.x - ln.start.x, ln.end.y - ln.start.y) < 0.001) return null;
      const baseOffset = parseFloat(ln.attrs.base_offset || '0') || 0;
      let startZ = baseOffset, endZ = baseOffset;
      const slab = resolveRef(ctx, hostRef, el.id);
      if (slab && SLAB_HOSTS.has(slab.tableName)) {
        host = 'slab';
        startZ = endZ = parseFloat(slab.attrs.base_offset || '0') || 0;
      } else if (el.geometry === 'spatial_line') {
        startZ = (el as SpatialLineElement).startZ;
        endZ = (el as SpatialLineElement).endZ;
      } else {
        startZ = parseFloat(ln.attrs.start_z || `${baseOffset}`) || baseOffset;
        endZ = parseFloat(ln.attrs.end_z || `${baseOffset}`) || baseOffset;
      }
      paths = [lineRailPath(ln.start, ln.end, startZ, endZ)];
    }
    const segs = paths[0];
    const first = segs[0].a, last = segs[segs.length - 1].b;
    const plan = railPlan(segs);
    let horLen = 0;
    for (let i = 1; i < plan.length; i++) horLen += Math.hypot(plan[i].x - plan[i - 1].x, plan[i].y - plan[i - 1].y);
    return {
      id: el.id,
      start: { x: first.x, y: first.y }, end: { x: last.x, y: last.y },
      startZ: first.z, endZ: last.z,
      height: style.height,
      baseY: ctx.levelElevation,
      material,
      horLen,
      angle: Math.atan2(last.y - first.y, last.x - first.x),
      paths, plan, style, host, side,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#546e7a';
    // Rail line + baluster ticks so the path reads as a railing, not a thick line.
    const tickHalf = 0.06;
    const ticks: ReactNode[] = [];
    const spacing = facts.style.infill === 'balusters' ? Math.max(0.05, facts.style.balusterSpacing) : 0.5;
    for (let i = 1; i < facts.plan.length; i++) {
      const a = facts.plan[i - 1], b = facts.plan[i];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < 1e-6) continue;
      const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
      const count = Math.max(1, Math.round(l / spacing));
      for (let j = 0; j <= count; j++) {
        if (j === 0 && i > 1) continue;
        const t = (j / count) * l;
        const cx = a.x + ux * t, cy = a.y + uy * t;
        ticks.push(
          <line key={`${i}-${j}`}
            x1={cx - uy * tickHalf} y1={cy + ux * tickHalf}
            x2={cx + uy * tickHalf} y2={cy - ux * tickHalf}
            stroke={stroke} strokeWidth={0.012} />,
        );
      }
    }
    return (
      <g data-id={facts.id}>
        <polyline points={facts.plan.map(p => `${p.x},${p.y}`).join(' ')} fill="none"
          stroke="transparent" strokeWidth={0.2} pointerEvents="stroke" />
        <polyline points={facts.plan.map(p => `${p.x},${p.y}`).join(' ')} fill="none"
          stroke={stroke} strokeWidth={drawCtx.selected ? 0.04 : 0.03} strokeLinejoin="miter" />
        {ticks}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'railing'));
    const glass = getBimMaterial('glass');
    const isHL = drawCtx.selected || drawCtx.hovered;
    return (
      <group>
        {facts.paths.map((segs, i) => railingMeshes(segs, facts.baseY, facts.style, material, glass, isHL, facts.id, `p${i}`))}
      </group>
    );
  },

  bbox(facts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.plan) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },

  // A stair railing has no editable geometry of its own (it follows the stair).
  selectionHandles(facts) {
    return facts.host === 'stair' ? [] : undefined;
  },
};

registerElement(railingModule);
