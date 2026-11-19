/**
 * Stair run — one straight flight hosted on a parent stair (host_id). The
 * stair's own line is its first run; L / U / switchback stairs add stair_run
 * and stair_landing rows (geometry/stair.ts).
 *
 * 2D: treads split at the plan cut (the parent stair draws the walking line).
 * 3D: solid flight, repeated with the parent's multi-storey repetitions.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';
import { runPlan, STAIR_CUT_HEIGHT, findStair, hostRefOf, runOf, stairRepetitionsIn, type StairRepetition, type StairRun } from '../geometry/stair.ts';
import { flightMesh } from './_stair3D.tsx';
import { drawRunPlan } from './stair.tsx';

export interface StairRunFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  baseY: number;
  material: string;
  footprint2D: Point[];
  angle: number;
  horLen: number;
  run: StairRun;
  reps: StairRepetition[];
}

export const stairRunModule: ElementModule<StairRunFacts> = {
  table: 'stair_run',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'sr',
  hostType: 'stair',
  hostTables: ['stair'],
  csvHeaders: ['number', 'base_offset', 'host_id', 'start_z', 'end_z', 'width', 'step_count', 'material'],
  defaults: {
    base_offset: '0', host_id: '',
    start_z: '0', end_z: '3', width: '1.2', step_count: '18',
  },
  drawingFields: [
    { key: 'width', label: 'Width', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'step_count', label: 'Steps', type: 'number', min: 1, step: 1 },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Stair Runs', color: '#7b68ee', icon: '⊟', order: 9.02 },
  renderZIndex: 30,

  geometry(el: CanonicalElement, ctx: GeometryContext): StairRunFacts | null {
    const run = runOf(el);
    if (!run) return null;
    // Plan outline (an annular band for a curved run)
    const footprint2D: Point[] = runPlan(run, STAIR_CUT_HEIGHT).outline;
    const host = findStair(ctx, hostRefOf(el), el.id);
    return {
      id: el.id,
      start: run.start, end: run.end,
      startZ: run.startZ, endZ: run.endZ, width: run.width, stepCount: run.stepCount,
      baseY: ctx.levelElevation,
      material: el.attrs.material || host?.attrs.material || 'concrete',
      footprint2D,
      angle: Math.atan2(run.u.y, run.u.x),
      horLen: run.length,
      run,
      reps: host ? stairRepetitionsIn(host, ctx) : [{ index: 0, levelId: ctx.level.id, dz: 0, scale: 1 }],
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    return <g data-id={facts.id}>{drawRunPlan(facts.run, stroke)}</g>;
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    return <group>{facts.reps.map(rep => flightMesh(`f${rep.index}`, facts.run, facts.baseY, rep, material, isHL, facts.id))}</group>;
  },

  bbox(facts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.footprint2D) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(stairRunModule);
