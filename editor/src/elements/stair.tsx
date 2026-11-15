/**
 * Stair — spatial-line archetype; the line is the stair's first run. Further
 * runs / landings (stair_run, stair_landing) and stair railings host on it
 * (geometry/stair.ts has the assembly rules).
 * 2D: the run's treads split at the plan cut (above = dashed) with a break
 *     line, plus the walking line over every run and landing with UP.
 * 3D: solid flight (steps + soffit), repeated per storey for multi-storey stairs.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS, STAIR_TYPE_OPTIONS } from './_options.ts';
import { resolvePropertyFields } from './_propertyFields.ts';
import {
  runOf, runPlan, stairAssemblyIn, stairCalc, stairRepetitionsIn, walkingLine, STAIR_CUT_HEIGHT,
  type StairAssembly, type StairCalc, type StairRepetition, type StairRun,
} from '../geometry/stair.ts';
import { flightMesh } from './_stair3D.tsx';
import StairPropertyPanel from './StairPropertyPanel.tsx';
import { STAIR_RAILINGS_KEY } from '../model/stairElements.ts';
import { drawingLabel, drawingLang } from '../export/drawing/labels.ts';

export interface StairFacts {
  id: string;
  start: Point;
  end: Point;
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  baseY: number;          // level elevation (treads are in level-local Z)
  material: string;
  footprint2D: Point[];   // 2D plan footprint (rectangular along axis)
  angle: number;          // around Y, atan2(dy,dx)
  horLen: number;
  /** The stair's own run. */
  run: StairRun;
  /** All runs and landings of the stair. */
  assembly: StairAssembly;
  /** Storeys it occupies (index 0 = itself). */
  reps: StairRepetition[];
  calc: StairCalc | null;
}


const CSV_HEADERS = ['number', 'base_offset', 'top_level_id', 'top_offset', 'start_z', 'end_z', 'width', 'step_count', 'stair_type', 'material', 'multistory_top_level_id'];

const DRAWING_FIELDS = [
  { key: 'stair_type', label: 'Type', type: 'select' as const, options: STAIR_TYPE_OPTIONS },
  { key: 'width', label: 'Width', type: 'number' as const, unit: 'm', min: 0.3, step: 0.1 },
  { key: 'step_count', label: 'Steps', type: 'number' as const, min: 1, step: 1 },
  {
    key: STAIR_RAILINGS_KEY, label: 'Railings', type: 'select' as const, options: [
      { value: 'both', label: 'Both Sides' }, { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' }, { value: 'none', label: 'None' },
    ],
  },
  BASE_OFFSET_FIELD,
];

export const stairModule: ElementModule<StairFacts> = {
  table: 'stair',
  discipline: 'architecture',
  archetype: 'spatial-line',
  prefix: 'st',
  hasVerticalSpan: true,
  csvHeaders: CSV_HEADERS,
  defaults: {
    base_offset: '0', top_level_id: '', top_offset: '0',
    start_z: '0', end_z: '3', width: '1.2', step_count: '18', stair_type: 'straight',
  },
  drawingFields: DRAWING_FIELDS,
  // multistory_top_level_id is edited in the stair panel (a level picker).
  propertyFields: resolvePropertyFields(
    CSV_HEADERS.filter(k => k !== 'multistory_top_level_id' && k !== 'start_z' && k !== 'end_z'),
    [...DRAWING_FIELDS.filter(f => !f.key.startsWith('__')), { key: 'material', label: 'Material', type: 'select', options: MATERIAL_OPTIONS }],
  ),
  layerStyle: { displayName: 'Stairs', color: '#7b68ee', icon: '⊞', order: 9 },
  renderZIndex: 30,
  propertyPanel: StairPropertyPanel,
  placementDefaults: () => ({ [STAIR_RAILINGS_KEY]: 'both' }),

  geometry(el: CanonicalElement, ctx: GeometryContext): StairFacts | null {
    const run = runOf(el);
    if (!run) return null;
    const hw = run.width / 2;
    const nx = -run.u.y, ny = run.u.x;
    const footprint2D: Point[] = [
      { x: run.start.x + nx * hw, y: run.start.y + ny * hw },
      { x: run.end.x + nx * hw, y: run.end.y + ny * hw },
      { x: run.end.x - nx * hw, y: run.end.y - ny * hw },
      { x: run.start.x - nx * hw, y: run.start.y - ny * hw },
    ];
    const assembly = stairAssemblyIn(ctx, el);
    const reps = stairRepetitionsIn(el, ctx);
    return {
      id: el.id,
      start: run.start, end: run.end,
      startZ: run.startZ, endZ: run.endZ, width: run.width, stepCount: run.stepCount,
      baseY: ctx.levelElevation,
      material: el.attrs.material || 'concrete',
      footprint2D,
      angle: Math.atan2(run.u.y, run.u.x),
      horLen: run.length,
      run, assembly, reps,
      calc: stairCalc(assembly, 1, reps.map(r => r.scale)),
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7b68ee';
    return (
      <g data-id={facts.id}>
        {facts.assembly.ownIsRun ? drawRunPlan(facts.run, stroke) : (
          <line x1={facts.start.x} y1={facts.start.y} x2={facts.end.x} y2={facts.end.y}
            stroke="transparent" strokeWidth={facts.width} pointerEvents="stroke" />
        )}
        {drawWalkingLine(facts.assembly, stroke)}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const material = getBimMaterial(resolveBimMaterial(facts.material, 'stair'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    if (!facts.assembly.ownIsRun) return null;
    return <group>{facts.reps.map(rep => flightMesh(`f${rep.index}`, facts.run, facts.baseY, rep, material, isHL, facts.id))}</group>;
  },

  bbox(facts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of facts.footprint2D) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

/** Run outline + treads; parts beyond the plan cut dashed, with the break line. */
export function drawRunPlan(run: StairRun, stroke: string): ReactNode {
  const plan = runPlan(run, STAIR_CUT_HEIGHT);
  const fill = plan.outline.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <>
      <polygon points={fill} fill="rgba(123,104,238,0.10)" stroke="none" />
      {plan.lines.map((l, i) => (
        <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y}
          stroke={stroke} strokeWidth={i < 4 ? 0.025 : 0.015}
          strokeDasharray={l.above ? '0.08 0.05' : undefined} />
      ))}
      {plan.breakLine && (
        <polyline points={plan.breakLine.map(p => `${p.x},${p.y}`).join(' ')}
          fill="none" stroke={stroke} strokeWidth={0.02} />
      )}
    </>
  );
}

/** Walking line over all runs and landings: dot at the bottom, arrow at the top, UP label. */
function drawWalkingLine(asm: StairAssembly, stroke: string): ReactNode {
  const pts = walkingLine(asm);
  if (pts.length < 2) return null;
  const first = asm.runs[0];
  const goingUp = !first || first.endZ >= first.startZ;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
  const head = Math.min(0.3, (first?.width ?? 1) * 0.3);
  const back = { x: b.x - ux * head, y: b.y - uy * head };
  const headPts = `${b.x},${b.y} ${back.x - uy * head * 0.4},${back.y + ux * head * 0.4} ${back.x + uy * head * 0.4},${back.y - ux * head * 0.4}`;
  const line = [...pts.slice(0, -1), back].map(p => `${p.x},${p.y}`).join(' ');
  // Label beside the first run, a little up from its start
  const s = pts[0];
  const u0 = first?.u ?? { x: ux, y: uy };
  const off = Math.min(0.6, (first?.length ?? 1) * 0.25);
  const lp = { x: s.x + u0.x * off - u0.y * (first?.width ?? 1) * 0.22, y: s.y + u0.y * off + u0.x * (first?.width ?? 1) * 0.22 };
  return (
    <>
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={0.02} />
      <polygon points={headPts} fill={stroke} stroke="none" />
      <circle cx={s.x} cy={s.y} r={0.05} fill={stroke} />
      <text
        x={lp.x} y={lp.y}
        fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={600}
        fill={stroke} textAnchor="middle" dominantBaseline="central"
        transform={`translate(${lp.x},${lp.y}) scale(1,-1) translate(${-lp.x},${-lp.y})`}
      >
        {drawingLabel(drawingLang(), goingUp ? 'plan.up' : 'plan.down')}
      </text>
    </>
  );
}

registerElement(stairModule);
