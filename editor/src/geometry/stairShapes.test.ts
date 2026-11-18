import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { Point } from '../model/elements.ts';
import {
  assembleStair, layoutCurvedStair, layoutStair, planStairZ, railPlan, runPlan, runTreads, stairCalc, stairRailPath,
  totalRisers, walkingLine, winderGeometry, type StairLayout,
} from './stair.ts';
import { sketchToLayout } from './stairSketch.ts';
import { applyStairConsistency, stairElements } from '../model/stairElements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { serializeToCsv, serializeToGeoJson } from '../model/serialize.ts';

const near = (p: Point, x: number, y: number, eps = 1e-6) => Math.abs(p.x - x) < eps && Math.abs(p.y - y) < eps;

function build(layout: StairLayout, width = 1.2) {
  const els = stairElements({ layout, existingIds: [], levelId: 'lv-1', attrs: { stair_type: 'x' }, width, railings: 'both' });
  const stair = els.find(e => e.tableName === 'stair')!;
  return { els, stair, asm: assembleStair(stair, els.filter(e => e.id !== stair.id)) };
}

/** Write the elements as the editor saves them and read them back. */
function roundTrip(els: ReturnType<typeof build>['els']) {
  const layers = ['stair', 'stair_run', 'stair_landing'].map(t => {
    const rows = els.filter(e => e.tableName === t);
    const csv = serializeToCsv(rows, t);
    const [head, ...lines] = csv.trim().split('\n');
    const keys = head.split(',');
    const csvRows = new Map(lines.map(line => {
      const row: Record<string, string> = {};
      line.split(',').forEach((v, i) => { row[keys[i]] = v; });
      return [row.id, row];
    }));
    return { tableName: t, discipline: 'architecture', csvRows, geojsonContent: serializeToGeoJson(rows) };
  });
  const all = parseFloorLayers(layers as never);
  const stair = all.find(e => e.tableName === 'stair')!;
  return { all, asm: assembleStair(stair, all.filter(e => e.id !== stair.id)) };
}

describe('winder stairs', () => {
  it('L with 3 winders: risers shared, landing turns as treads radiating from the inner corner', () => {
    const layout = layoutStair([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], 1.2, 18, 0, 3, 3)!;
    expect(layout.runs.reduce((s, r) => s + r.steps, 0)).toBe(15);
    expect(layout.landings[0].steps).toBe(3);
    const riser = 3 / 18;
    expect(layout.runs[1].startZ).toBeCloseTo(layout.runs[0].endZ + 3 * riser, 4);
    expect(layout.runs[1].endZ).toBeCloseTo(3, 4);
    const { asm, els } = build(layout);
    expect(els.find(e => e.tableName === 'stair_landing')!.attrs.step_count).toBe('3');
    expect(totalRisers(asm)).toBe(18);
    const w = winderGeometry(asm, asm.landings[0])!;
    expect(near(w.pivot, 3.4, 0.6)).toBe(true); // inner corner of the corner square
    expect(w.treads).toHaveLength(3);
    expect(w.lines).toHaveLength(2);
    for (const l of w.lines) expect(near(l.a, 3.4, 0.6)).toBe(true);
    expect(w.treads.map(t => t.top)).toEqual([1, 2, 3].map(i => expect.closeTo(layout.runs[0].endZ + i * riser, 4)));
    // The last winder tread is the floor the next run starts on
    expect(w.treads[2].top).toBeCloseTo(layout.runs[1].startZ, 4);
    // Treads tile the landing
    const area = (p: Point[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a.x * b.y - a.y * b.x; }, 0) / 2);
    expect(w.treads.reduce((s, t) => s + area(t.poly), 0)).toBeCloseTo(1.44, 6);
    // Calculator: 18 risers, winder going = walking line across the turn / 3
    const c = stairCalc(asm)!;
    expect(c.risers).toBe(18);
    expect(c.riser).toBeCloseTo(riser, 6);
    expect(c.going).toBeLessThanOrEqual(1.2 / 3 + 1e-9);
  });

  it('riser rule keeps the winders: consistency moves the next run above them', () => {
    const layout = layoutStair([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], 1.2, 18, 0, 3, 3)!;
    const { els, stair } = build(layout);
    const next = new Map(els.map(e => [e.id, e]));
    next.set(stair.id, { ...stair, attrs: { ...stair.attrs, top_level_id: 'lv-2', top_offset: '0' } });
    applyStairConsistency(next, [stair.id], [{ id: 'lv-1', name: '1', elevation: 0 }, { id: 'lv-2', name: '2', elevation: 3.6 }] as never, 'lv-1');
    const all = [...next.values()];
    const asm = assembleStair(next.get(stair.id)!, all.filter(e => e.id !== stair.id));
    const plan = planStairZ(asm, 0, 3.6);
    const r = 3.6 / 18;
    expect(plan.runs.get(asm.runs[1].id)!.startZ).toBeCloseTo(asm.runs[0].stepCount * r + 3 * r, 4);
    expect(asm.runs[1].endZ).toBeCloseTo(3.6, 4);
  });

  it('U with winders: treads radiate from the well side, rails climb across the turn', () => {
    const layout = layoutStair([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.4 }, { x: 0, y: 1.4 }], 1.2, 20, 0, 3, 6)!;
    const { asm } = build(layout);
    const w = winderGeometry(asm, asm.landings[0])!;
    expect(w.treads).toHaveLength(6);
    expect(near(w.pivot, layout.runs[0].end.x, 0.7)).toBe(true);
    const outer = stairRailPath(asm, 'right');
    const zs = outer.flatMap(s => [s.a.z, s.b.z]);
    for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThanOrEqual(zs[i - 1] - 1e-9);
    expect(totalRisers(asm)).toBe(20);
  });
});

describe('curved and spiral stairs', () => {
  it('curved run: arc walking line, wedge treads, plan band, rails on the offset arcs, saved as a GeoJSON arc', () => {
    const layout = layoutCurvedStair({ x: 0, y: 0 }, 3, 0, true, 12, 0.3, 0, 2)!;
    expect(layout.runs).toHaveLength(1);
    const r0 = layout.runs[0];
    expect(r0.arc!.sweep).toBeCloseTo(1.2, 6);
    expect(near(r0.end, 3 * Math.cos(1.2), 3 * Math.sin(1.2))).toBe(true);
    const { els } = build(layout, 1.2);
    const { asm } = roundTrip(els);
    const run = asm.runs[0];
    expect(run.arc).toBeDefined();
    expect(Math.hypot(run.arc!.cx, run.arc!.cy)).toBeLessThan(0.01);
    expect(run.length).toBeCloseTo(3.6, 2);
    const treads = runTreads(run);
    expect(treads).toHaveLength(12);
    expect(treads[11].top).toBeCloseTo(2, 4);
    for (const t of treads) for (const p of t.poly) {
      const rad = Math.hypot(p.x, p.y);
      expect(rad).toBeGreaterThan(2.4 - 0.01);
      expect(rad).toBeLessThan(3.6 + 0.01);
    }
    const plan = runPlan(run, 1.2);
    expect(plan.outline.length).toBeGreaterThan(10);
    expect(plan.breakLine).toBeDefined();
    // Left of a counter-clockwise run is the inner side
    const left = railPlan(stairRailPath(asm, 'left'));
    for (const p of left) expect(Math.hypot(p.x, p.y)).toBeCloseTo(3 - 0.55, 2);
    expect(walkingLine(asm).length).toBeGreaterThan(5);
    const c = stairCalc(asm)!;
    expect(c.going).toBeCloseTo(0.3, 2);
  });

  it('spiral past 270° splits into runs continuing round the same centre', () => {
    const layout = layoutCurvedStair({ x: 5, y: 5 }, 0.8, Math.PI / 2, false, 18, 0.25, 0, 3)!;
    expect(layout.runs.length).toBe(2);
    expect(layout.runs.reduce((s, r) => s + r.steps, 0)).toBe(18);
    expect(near(layout.runs[0].end, layout.runs[1].start.x, layout.runs[1].start.y)).toBe(true);
    for (const r of layout.runs) expect(Math.abs(r.arc!.sweep)).toBeLessThan(1.5 * Math.PI + 1e-9);
    const { asm } = build(layout, 1);
    expect(asm.runs).toHaveLength(2);
    expect(asm.runs[0].arc!.sweep).toBeLessThan(0);
    expect(stairCalc(asm)!.risers).toBe(18);
  });
});

describe('stair by sketch', () => {
  const riser = (x: number, y0: number, y1: number): [Point, Point] => [{ x, y: y0 }, { x, y: y1 }];

  it('parallel risers → one run: risers = lines, going = spacing, last tread past the last line', () => {
    const risers = Array.from({ length: 10 }, (_, i) => riser(i * 0.28, -0.6, 0.6));
    const l = sketchToLayout({ boundary: [], risers }, 0, 1.7);
    if ('error' in l) throw new Error(l.error);
    expect(l.runs).toHaveLength(1);
    expect(l.runs[0].steps).toBe(10);
    expect(near(l.runs[0].start, 0, 0)).toBe(true);
    expect(near(l.runs[0].end, 2.8, 0)).toBe(true);
    expect(l.runs[0].width).toBeCloseTo(1.2, 6);
  });

  it('drawn in any order: the first riser drawn is the bottom', () => {
    const risers = Array.from({ length: 6 }, (_, i) => riser(5 - i * 0.3, 0, 1));
    const shuffled = [risers[0], risers[3], risers[5], risers[1], risers[4], risers[2]];
    const l = sketchToLayout({ boundary: [], risers: shuffled }, 0, 1);
    if ('error' in l) throw new Error(l.error);
    expect(l.runs[0].start.x).toBeCloseTo(5, 6);
    expect(l.runs[0].end.x).toBeCloseTo(3.2, 6);
  });

  it('L sketch with a boundary: flat corner landing clipped from the boundary', () => {
    const a = Array.from({ length: 8 }, (_, i) => riser(i * 0.3, 0, 1.2));
    const b = Array.from({ length: 8 }, (_, i): [Point, Point] => [{ x: 2.4, y: 1.2 + i * 0.3 + 0.0 + 1.2 - 1.2 }, { x: 3.6, y: 1.2 + i * 0.3 }]);
    const boundary = [{ x: 0, y: 0 }, { x: 3.6, y: 0 }, { x: 3.6, y: 3.6 }, { x: 2.4, y: 3.6 }, { x: 2.4, y: 1.2 }, { x: 0, y: 1.2 }];
    const l = sketchToLayout({ boundary, risers: [...a, ...b] }, 0, 16 * 0.17);
    if ('error' in l) throw new Error(l.error);
    expect(l.runs.map(r => r.steps)).toEqual([8, 8]);
    expect(l.landings).toHaveLength(1);
    expect(l.landings[0].steps).toBeUndefined();
    const xs = l.landings[0].vertices.map(v => v.x), ys = l.landings[0].vertices.map(v => v.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(v => Math.round(v * 1e6) / 1e6)).toEqual([2.4, 3.6, 0, 1.2]);
    expect(l.landings[0].top).toBeCloseTo(8 * 0.17, 4);
  });

  it('turned risers between two runs become a winder landing', () => {
    const a = Array.from({ length: 9 }, (_, i) => riser(i * 0.3, 0, 1.2)); // last line (x = 2.4) is the first winder riser
    const pivot = { x: 2.4, y: 1.2 };
    const winders: [Point, Point][] = [30, 60].map(d => {
      const t = (d * Math.PI) / 180;
      return [pivot, { x: pivot.x + Math.sin(t) * 1.4, y: pivot.y - Math.cos(t) * 1.4 }];
    });
    const b = Array.from({ length: 6 }, (_, i): [Point, Point] => [{ x: 2.4, y: 1.2 + i * 0.3 }, { x: 3.6, y: 1.2 + i * 0.3 }]);
    const boundary = [{ x: 0, y: 0 }, { x: 3.6, y: 0 }, { x: 3.6, y: 3.0 }, { x: 2.4, y: 3.0 }, { x: 2.4, y: 1.2 }, { x: 0, y: 1.2 }];
    const l = sketchToLayout({ boundary, risers: [...a, ...winders, ...b] }, 0, 3);
    if ('error' in l) throw new Error(l.error);
    expect(l.runs.map(r => r.steps)).toEqual([8, 6]);
    expect(l.landings[0].steps).toBe(3);
    const total = 8 + 3 + 6;
    expect(l.runs[1].startZ).toBeCloseTo(11 * 3 / total, 4);
    const { asm } = build(l);
    expect(totalRisers(asm)).toBe(17);
    expect(winderGeometry(asm, asm.landings[0])!.treads).toHaveLength(3);
  });

  it('needs at least two risers', () => {
    expect(sketchToLayout({ boundary: [], risers: [riser(0, 0, 1)] }, 0, 3)).toEqual({ error: 'risers' });
  });
});
