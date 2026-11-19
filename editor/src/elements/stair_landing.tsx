/**
 * Stair landing — polygon platform hosted on a `stair` row. Multiple landings
 * can share the same host_id (U / W / switchback stairs). `base_offset` is the
 * landing top; the editor keeps it at the top of the run arriving on it.
 *
 * 2D: filled polygon, outline dashed when the landing is above the plan cut.
 * 3D: slab hanging `thickness` below its top, repeated with the parent's
 *     multi-storey repetitions.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';
import { resolvePropertyFields } from './_propertyFields.ts';
import {
  findStair, hostRefOf, landingOf, stairAssemblyIn, stairRepetitionsIn, winderGeometry, STAIR_CUT_HEIGHT, LANDING_DEFAULT_THICKNESS,
  type StairLanding, type StairRepetition, type WinderGeometry,
} from '../geometry/stair.ts';
import { landingMesh, treadsMesh } from './_stair3D.tsx';

export interface StairLandingFacts {
  id: string;
  vertices: Point[];
  /** World elevation of the landing top. */
  baseY: number;
  thickness: number;
  material: string;
  levelY: number;
  landing: StairLanding;
  reps: StairRepetition[];
  /** Winder landing (step_count > 0): its treads and risers. */
  winder: WinderGeometry | null;
}

const LANDING_HEADERS = ['number', 'host_id', 'base_offset', 'thickness', 'step_count', 'material'];

export const stairLandingModule: ElementModule<StairLandingFacts> = {
  table: 'stair_landing',
  discipline: 'architecture',
  archetype: 'surface',
  prefix: 'sl_land',
  hostType: 'stair',
  hostTables: ['stair'],
  csvHeaders: LANDING_HEADERS,
  defaults: {
    host_id: '', base_offset: '0', thickness: `${LANDING_DEFAULT_THICKNESS}`, material: 'concrete',
  },
  drawingFields: [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: resolvePropertyFields(LANDING_HEADERS, [
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
    { key: 'step_count', label: 'Winder Risers', type: 'number', min: 0, step: 1 },
    { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS },
    BASE_OFFSET_FIELD,
  ]),
  layerStyle: { displayName: 'Stair Landings', color: '#a99bdc', icon: '▢', order: 9.05 },
  renderZIndex: 29,

  geometry(el: CanonicalElement, ctx: GeometryContext): StairLandingFacts | null {
    const landing = landingOf(el);
    if (!landing) return null;
    const host = findStair(ctx, hostRefOf(el), el.id);
    return {
      id: el.id,
      vertices: landing.vertices,
      baseY: ctx.levelElevation + landing.top,
      thickness: landing.thickness,
      material: el.attrs.material || host?.attrs.material || 'concrete',
      levelY: ctx.levelElevation,
      landing,
      reps: host ? stairRepetitionsIn(host, ctx) : [{ index: 0, levelId: ctx.level.id, dz: 0, scale: 1 }],
      winder: host && landing.steps ? winderGeometry(stairAssemblyIn(ctx, host), landing) : null,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    const above = facts.landing.top > STAIR_CUT_HEIGHT;
    const points = facts.vertices.map(v => `${v.x},${v.y}`).join(' ');
    const outline = (
      <polygon
        points={points}
        fill="rgba(123,104,238,0.14)"
        stroke={stroke}
        strokeWidth={0.025}
        strokeDasharray={above ? '0.08 0.05' : undefined}
        data-id={facts.id}
      />
    );
    if (!facts.winder) return outline;
    // Winder risers radiating from the pivot; beyond the plan cut dashed
    return (
      <g data-id={facts.id}>
        {outline}
        {facts.winder.lines.map((l, i) => (
          <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke={stroke} strokeWidth={0.015}
            strokeDasharray={l.z > STAIR_CUT_HEIGHT ? '0.08 0.05' : undefined} />
        ))}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair_landing'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const w = facts.winder;
    return <group>{facts.reps.map(rep => w
      ? treadsMesh(`w${rep.index}`, w.treads, facts.landing.thickness, facts.levelY, rep, material, isHL, facts.id, w.floor)
      : landingMesh(`l${rep.index}`, facts.landing, facts.levelY, rep, material, isHL, facts.id))}</group>;
  },

  bbox(facts) {
    if (facts.vertices.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of facts.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(stairLandingModule);
