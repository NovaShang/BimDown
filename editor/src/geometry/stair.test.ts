import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import {
  assembleStair, layoutStair, planStairZ, railBalusters, railPlan, stairCalc, stairRailPath, stairRepetitions,
  walkingLine, type StairAssembly,
} from './stair.ts';
import { applyStairConsistency, stairElements } from '../model/stairElements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { serializeToCsv, serializeToGeoJson } from '../model/serialize.ts';

const near = (p: Point, x: number, y: number, eps = 1e-6) => Math.abs(p.x - x) < eps && Math.abs(p.y - y) < eps;

/** Elements of a stair placed through the layout (as the stair tool does). */
function placed(points: Point[], width = 1, steps = 18, rise = 3) {
  const layout = layoutStair(points, width, steps, 0, rise)!;
  const els = stairElements({ layout, existingIds: [], levelId: 'lv-1', attrs: { stair_type: 'x' }, width, railings: 'both' });
  const stair = els.find(e => e.tableName === 'stair')!;
  return { layout, els, stair, asm: assembleStair(stair, els.filter(e => e.id !== stair.id)) };
}

describe('stair layout (tool)', () => {
  it('L stair: runs stop at the square corner landing, risers shared by length', () => {
    const { layout, els } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]);
    expect(layout.runs.map(r => r.steps)).toEqual([9, 9]);
    expect(near(layout.runs[0].end, 3.5, 0)).toBe(true);
    expect(near(layout.runs[1].start, 4, 0.5)).toBe(true);
    expect(layout.runs[0].endZ).toBeCloseTo(1.5, 6);
    expect(layout.landings[0].top).toBeCloseTo(1.5, 6);
    const xs = layout.landings[0].vertices.map(v => v.x), ys = layout.landings[0].vertices.map(v => v.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3.5, 4.5, -0.5, 0.5]);
    expect(els.map(e => e.tableName).sort()).toEqual(['railing', 'railing', 'stair', 'stair_landing', 'stair_run']);
    // Parts and railings are hosted on the stair
    const stairId = els.find(e => e.tableName === 'stair')!.id;
    expect(els.filter(e => e.tableName !== 'stair').every(e => e.hostId === stairId && e.attrs.host_id === stairId)).toBe(true);
  });

  it('U stair: landing spans both runs, one run width deep', () => {
    const { layout } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.2 }, { x: 0, y: 1.2 }]);
    const v = layout.landings[0].vertices;
    const xs = v.map(p => p.x), ys = v.map(p => p.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3.5, 4.5, -0.5, 1.7]);
    expect(near(layout.runs[1].start, 3.5, 1.2)).toBe(true);
    expect(layout.runs[1].endZ).toBeCloseTo(3, 6);
  });
});

describe('stair railing path', () => {
  const zAt = (segs: ReturnType<typeof stairRailPath>, x: number, y: number) =>
    segs.flatMap(s => [s.a, s.b]).find(p => near(p, x, y, 1e-3))?.z;

  it('straight: along both edges, inset, rising with the nosing line', () => {
    const { asm } = placed([{ x: 0, y: 0 }, { x: 5.04, y: 0 }], 1.2, 18);
    const left = railPlan(stairRailPath(asm, 'left'));
    expect(left.every(p => Math.abs(p.y - 0.55) < 1e-9)).toBe(true);
    const right = stairRailPath(asm, 'right');
    expect(railPlan(right).every(p => Math.abs(p.y + 0.55) < 1e-9)).toBe(true);
    // Nosing line: first tread top at the start, flat over the last tread
    expect(right[0].a.z).toBeCloseTo(3 / 18, 6);
    expect(right[right.length - 1].b.z).toBeCloseTo(3, 6);
    // Balusters stand on the treads
    const b = railBalusters(right, 0.12, 0.9);
    expect(b.length).toBeGreaterThan(30);
    for (const p of b) expect(p.z1 - p.z0).toBeGreaterThan(0.7);
  });

  it('L: inner rail turns at the inner corner, outer rail goes round the landing', () => {
    const { asm } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]);
    const inner = stairRailPath(asm, 'left');
    const innerPlan = railPlan(inner);
    expect(innerPlan.some(p => near(p, 3.55, 0.45, 1e-6))).toBe(true);
    expect(innerPlan.some(p => p.x > 3.6 && p.y < 0.4)).toBe(false); // never crosses the landing
    const outer = stairRailPath(asm, 'right');
    const outerPlan = railPlan(outer);
    expect(outerPlan.some(p => near(p, 4.45, -0.45))).toBe(true);
    expect(zAt(outer, 4.45, -0.45)).toBeCloseTo(1.5, 6); // landing height
    expect(near(outerPlan[outerPlan.length - 1], 4.45, 4)).toBe(true);
  });

  it('U: well side crosses between the runs, outer side goes round three landing edges', () => {
    const { asm } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.2 }, { x: 0, y: 1.2 }]);
    const well = railPlan(stairRailPath(asm, 'left'));
    expect(well.some(p => near(p, 3.55, 0.45))).toBe(true);
    expect(well.some(p => near(p, 3.55, 0.75))).toBe(true);
    expect(well.every(p => p.x <= 3.55 + 1e-9)).toBe(true);
    const outer = railPlan(stairRailPath(asm, 'right'));
    expect(outer.some(p => near(p, 4.45, -0.45))).toBe(true);
    expect(outer.some(p => near(p, 4.45, 1.65))).toBe(true);
    expect(near(outer[outer.length - 1], 0, 1.65)).toBe(true);
  });

  it('walking line goes through the L corner and across the U landing', () => {
    expect(walkingLine(placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]).asm).some(p => near(p, 4, 0))).toBe(true);
    const u = walkingLine(placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.2 }, { x: 0, y: 1.2 }]).asm);
    expect(u.some(p => near(p, 4, 0)) && u.some(p => near(p, 4, 1.2))).toBe(true);
  });
});

describe('multi-storey stairs', () => {
  const elev = new Map([['lv-1', 0], ['lv-2', 3], ['lv-3', 6.5], ['lv-4', 10]]);
  it('repeats per storey up to the top level, riser adapting to each storey', () => {
    const reps = stairRepetitions({ multistory_top_level_id: 'lv-4' }, 'lv-1', 0, elev);
    expect(reps.map(r => r.levelId)).toEqual(['lv-1', 'lv-2', 'lv-3']);
    expect(reps.map(r => r.dz)).toEqual([0, 3, 6.5]);
    expect(reps[1].scale).toBeCloseTo(3.5 / 3, 9);
    expect(stairRepetitions({}, 'lv-1', 0, elev)).toHaveLength(1);
    expect(stairRepetitions({ multistory_top_level_id: 'lv-1' }, 'lv-1', 0, elev)).toHaveLength(1);
    // The calculator checks every storey's riser
    const { asm } = placed([{ x: 0, y: 0 }, { x: 5.04, y: 0 }], 1.2, 18);
    expect(stairCalc(asm)!.checks.find(c => c.key === 'riser')!.ok).toBe(true);
    const calc = stairCalc(asm, 1, reps.map(r => r.scale))!;
    expect(calc.checks.find(c => c.key === 'riser')!.ok).toBe(false); // 3.5 m / 18 = 194 mm
  });
});

describe('stair calculator', () => {
  it('riser, going, 2R+G and width', () => {
    const ok = stairCalc(placed([{ x: 0, y: 0 }, { x: 5.04, y: 0 }], 1.2, 18).asm)!;
    expect(ok.riser).toBeCloseTo(3 / 18, 9);
    expect(ok.going).toBeCloseTo(0.28, 9);
    expect(ok.blondel).toBeCloseTo(2 * 3 / 18 + 0.28, 9);
    expect(ok.checks.every(c => c.ok)).toBe(true);
    const bad = stairCalc(placed([{ x: 0, y: 0 }, { x: 2.4, y: 0 }], 0.8, 12).asm)!;
    const failed = bad.checks.filter(c => !c.ok).map(c => c.key).sort();
    expect(failed).toEqual(['blondel', 'going', 'riser', 'width']);
  });
});

describe('stair consistency', () => {
  it('more risers in one run re-share the rise; the landing follows the runs', () => {
    const { els, stair } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]);
    const next = new Map<string, CanonicalElement>(els.map(e => [e.id, e]));
    const run = els.find(e => e.tableName === 'stair_run')!;
    next.set(run.id, { ...run, attrs: { ...run.attrs, step_count: '11' } });
    const levels = [{ id: 'lv-1', number: '1', name: 'L1', elevation: 0 }, { id: 'lv-2', number: '2', name: 'L2', elevation: 3 }];
    next.set(stair.id, { ...stair, attrs: { ...stair.attrs, top_level_id: 'lv-2', top_offset: '0', base_offset: '0' } });
    const changed = applyStairConsistency(next, [stair.id], levels, 'lv-1');
    expect(changed.length).toBeGreaterThan(0);
    const asm: StairAssembly = assembleStair(next.get(stair.id)!, [...next.values()].filter(e => e.id !== stair.id));
    const riser = 3 / 20;
    expect(asm.runs[0].endZ).toBeCloseTo(9 * riser, 4);
    expect(asm.runs[1].startZ).toBeCloseTo(9 * riser, 4);
    expect(asm.runs[1].endZ).toBeCloseTo(3, 4);
    expect(asm.landings[0].top).toBeCloseTo(9 * riser, 4);
    const plan = planStairZ(asm, 0, 3);
    expect(plan.landings.get(asm.landings[0].id)).toBeCloseTo(9 * riser, 4);
  });

  it('an overall stair axis spanning its runs is not a flight (exporter form)', () => {
    const stair = { id: 'st-1', tableName: 'stair', discipline: 'architecture', geometry: 'spatial_line', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, startZ: 0, endZ: 3, strokeWidth: 1, attrs: { step_count: '20' } } as CanonicalElement;
    const r = (id: string, x0: number, x1: number, y: number, z0: number, z1: number) => ({ id, tableName: 'stair_run', discipline: 'architecture', geometry: 'spatial_line', start: { x: x0, y }, end: { x: x1, y }, startZ: z0, endZ: z1, strokeWidth: 1, attrs: { host_id: 'st-1', step_count: '10', width: '1' } }) as CanonicalElement;
    const asm = assembleStair(stair, [r('sr-1', 0, 2.5, 0, 0, 1.5), r('sr-2', 2.5, 0, 1, 1.5, 3)]);
    expect(asm.ownIsRun).toBe(false);
    expect(asm.runs.map(x => x.id)).toEqual(['sr-1', 'sr-2']);
  });
});

describe('stair railings in files', () => {
  it('are CSV-only rows (no GeoJSON feature) and load back hosted on the stair', () => {
    const { els } = placed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]);
    const rails = els.filter(e => e.tableName === 'railing');
    const sketched = { id: 'rl-9', tableName: 'railing', discipline: 'architecture', geometry: 'spatial_line', start: { x: 0, y: 5 }, end: { x: 3, y: 5 }, startZ: 0, endZ: 0, strokeWidth: 0.05, attrs: { height: '1.1', host_id: 'sl-1' } } as CanonicalElement;
    const all = [...rails, sketched];
    const geo = serializeToGeoJson(all);
    expect(JSON.parse(geo).features.map((f: { properties: { id: string } }) => f.properties.id)).toEqual(['rl-9']);
    const csv = serializeToCsv(all, 'railing');
    expect(csv.split('\n')[0]).toContain('side');
    const stairLayer = (t: string) => ({ tableName: t, discipline: 'architecture', csvRows: new Map(), geojsonContent: '' });
    const rows = new Map(csv.split('\n').slice(1).map(line => {
      const h = csv.split('\n')[0].split(',');
      const v = line.split(',');
      const row: Record<string, string> = {};
      h.forEach((k, i) => { row[k] = v[i] ?? ''; });
      return [row.id, row];
    }));
    const parsed = parseFloorLayers([{ ...stairLayer('railing'), csvRows: rows, geojsonContent: geo } as never]);
    expect(parsed.filter(e => e.geometry === 'line').map(e => [e.id, e.hostId, e.attrs.side])).toEqual(
      rails.map(r => [r.id, r.attrs.host_id, r.attrs.side]),
    );
    expect(parsed.find(e => e.id === 'rl-9')!.geometry).toBe('spatial_line');
  });
});
