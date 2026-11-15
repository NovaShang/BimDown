import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectClashes, type ClashCurveIn } from './clash.js';
import { clashReport, formatClashReport } from './clash-load.js';

const dir = join(__dirname, 'test-clash');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[], props: Record<string, unknown> = {}) =>
  ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'LineString', coordinates: [a, b] } });
const point = (id: string, p: number[], props: Record<string, unknown> = {}) => ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Point', coordinates: p } });
const poly = (id: string, ring: number[][], props: Record<string, unknown> = {}) =>
  ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
const put = (rel: string, text: string) => writeFileSync(join(dir, rel), text);
const pair = (c: { a: string; b: string }) => [c.a, c.b].sort().join('+');

describe('bimdown clash', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const d of ['global', 'lv-1', 'lv-2']) mkdirSync(join(dir, d), { recursive: true });
    put('project_metadata.json', JSON.stringify({ format_version: 2, units: 'm' }));
    put('global/level.csv', 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,4\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('duct through a beam is a high hard clash', () => {
    // Beam top at 3.0, 300 × 500: its body spans z 2.5 – 3.0. The duct centre line is at 2.8.
    put('lv-1/beam.csv', 'id,shape,size_x,size_y,material\nbm-1,rect,0.3,0.5,concrete\n');
    put('lv-1/beam.geojson', fc([line('bm-1', [0, 0, 3], [10, 0, 3])]));
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\ndu-1,rect,0.4,0.3,SA,,\ndu-2,rect,0.4,0.3,SA,,\n');
    // du-2 passes below the beam (top 2.4 < 2.5): no clash
    put('lv-1/duct.geojson', fc([line('du-1', [5, -3, 2.8], [5, 3, 2.8]), line('du-2', [7, -3, 2.25], [7, 3, 2.25])]));
    const r = clashReport(dir);
    expect(r.clashes).toHaveLength(1);
    const c = r.clashes[0];
    expect(c).toMatchObject({ a: 'du-1', aTable: 'duct', b: 'bm-1', bTable: 'beam', severity: 'high', kind: 'hard', systems: ['SA'] });
    expect(c.at[0]).toBeCloseTo(5, 1);
    expect(c.at[1]).toBeCloseTo(0, 1);
    expect(c.at[2]).toBeGreaterThan(2.5);
    expect(c.at[2]).toBeLessThan(3);
    expect(c.depth).toBeGreaterThan(0.2);
    expect(r.counts).toEqual({ high: 1, medium: 0, low: 0 });
    expect(formatClashReport(r).join('\n')).toMatch(/HIGH \(1\)\n {2}lv-1\/duct du-1 {2}x {2}beam bm-1 {2}hard \d+ mm/);
    // --mep-only leaves structure out
    expect(clashReport(dir, { mepOnly: true }).clashes).toEqual([]);
  });

  it('a duct through an open-web joist\'s web does not clash; one through its chord does (audit r3: 494 false clashes)', () => {
    // 14K1-like joist: top at 3.0, 0.356 deep, 0.032 chords: web between z 2.676 and 2.968
    put('global/beam_type.csv', 'id,name,description,material,shape,size_x,size_y,flange,web,thickness,root_radius,designation,material_grade\nbmt-1,14K1,,steel,open_web,0.073,0.356,0.032,,0.0035,,14K1,\n');
    put('lv-1/beam.csv', 'id,type_id\nbm-1,bmt-1\n');
    put('lv-1/beam.geojson', fc([line('bm-1', [0, 0, 3], [10, 0, 3])]));
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\ndu-1,round,0.15,,SA,,\ndu-2,round,0.15,,SA,,\n');
    put('lv-1/duct.geojson', fc([line('du-1', [5, -3, 2.82], [5, 3, 2.82]), line('du-2', [7, -3, 2.98], [7, 3, 2.98])]));
    const r = clashReport(dir);
    expect(r.clashes.map(c => c.a)).toEqual(['du-2']);
  });

  it('a run split where it crosses a beam is one clash', () => {
    put('lv-1/beam.csv', 'id,shape,size_x,size_y,material\nbm-1,rect,0.3,0.5,concrete\n');
    put('lv-1/beam.geojson', fc([line('bm-1', [0, 0, 3], [10, 0, 3])]));
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\ndu-1,rect,0.4,0.3,SA,,\ndu-2,rect,0.4,0.3,SA,,\n');
    // Split at y = 0, inside the beam
    put('lv-1/duct.geojson', fc([line('du-1', [5, -3, 2.8], [5, 0, 2.8]), line('du-2', [5, 0, 2.8], [5, 3, 2.8])]));
    const r = clashReport(dir);
    expect(r.clashes.filter(c => c.b === 'bm-1')).toHaveLength(1);
  });

  it('crossing pipes of different systems at one height are a medium clash; a connected tee is not', () => {
    put('lv-1/mep_node.csv', 'id,system_type,kind,fitting\nmn-1,CHWS,,tee\n');
    put('lv-1/mep_node.geojson', fc([point('mn-1', [5, 8, 2.5])]));
    put('lv-1/pipe.csv', 'id,shape,size_x,size_y,system_type,from,to\n'
      + 'pi-1,round,0.1,,CHWS,,\npi-2,round,0.08,,HWS,,\n'
      // tee through mn-1 (refs) …
      + 'pi-3,round,0.1,,CHWS,,mn-1\npi-4,round,0.1,,CHWS,mn-1,\npi-5,round,0.05,,CHWS,mn-1,\n'
      // … and a branch tapping into pi-3's body with no refs at all
      + 'pi-6,round,0.05,,CHWS,,\n');
    put('lv-1/pipe.geojson', fc([
      line('pi-1', [0, 5, 2.5], [10, 5, 2.5]),
      line('pi-2', [5, 0, 2.5], [5, 10, 2.5]),
      line('pi-3', [0, 8, 2.5], [5, 8, 2.5]),
      line('pi-4', [5, 8, 2.5], [10, 8, 2.5]),
      line('pi-5', [5, 8, 2.5], [5, 9.5, 2.5]),
      line('pi-6', [2, 8, 2.5], [2, 9.5, 2.5]),
    ]));
    const r = clashReport(dir);
    const pairs = r.clashes.map(pair);
    expect(pairs).toContain('pi-1+pi-2');
    expect(r.clashes.find(c => pair(c) === 'pi-1+pi-2')).toMatchObject({ severity: 'medium', kind: 'hard' });
    expect(r.clashes.find(c => pair(c) === 'pi-1+pi-2')!.systems.sort()).toEqual(['CHWS', 'HWS']);
    // pi-2 (HWS) also crosses the CHWS trunk pi-3/pi-4 at x = 5 and the branch pi-5 runs inside it.
    for (const p of pairs) expect(p).toMatch(/pi-2/);
    for (const ok of ['pi-3+pi-4', 'pi-3+pi-5', 'pi-4+pi-5', 'pi-3+pi-6']) expect(pairs).not.toContain(ok);
  });

  it('a riser through the floor above is a low penetration unless an opening or shaft covers it', () => {
    put('lv-2/slab.csv', 'id,thickness,function\nsl-1,0.2,floor\n');
    put('lv-2/slab.geojson', fc([poly('sl-1', [[0, 0], [20, 0], [20, 20], [0, 20]])]));
    put('lv-1/pipe.csv', 'id,shape,size_x,size_y,system_type,from,to\npi-1,round,0.1,,SAN,,\npi-2,round,0.1,,SAN,,\n');
    put('lv-1/pipe.geojson', fc([line('pi-1', [15, 15, 1], [15, 15, 6]), line('pi-2', [5, 5, 1], [5, 5, 6])]));
    // A slab opening around pi-2
    put('lv-2/opening.csv', 'id,host_id\nop-1,sl-1\n');
    put('lv-2/opening.geojson', fc([poly('op-1', [[4.7, 4.7], [5.3, 4.7], [5.3, 5.3], [4.7, 5.3]])]));
    let r = clashReport(dir);
    expect(r.clashes).toHaveLength(1);
    expect(r.clashes[0]).toMatchObject({ a: 'pi-1', b: 'sl-1', bScope: 'lv-2', severity: 'low', kind: 'penetration' });
    expect(r.clashes[0].depth).toBeCloseTo(0.2, 6);
    expect(r.clashes[0].at[2]).toBeGreaterThanOrEqual(3.8);
    expect(r.clashes[0].at[2]).toBeLessThanOrEqual(4);
    // An opening smaller than the pipe still clashes
    put('lv-2/opening.geojson', fc([poly('op-1', [[4.98, 4.98], [5.02, 4.98], [5.02, 5.02], [4.98, 5.02]])]));
    expect(clashReport(dir).clashes.map(c => c.a).sort()).toEqual(['pi-1', 'pi-2']);
    // A shaft from lv-1 up to lv-2 + 0.5 covers pi-1
    put('lv-2/opening.geojson', fc([poly('op-1', [[4.7, 4.7], [5.3, 4.7], [5.3, 5.3], [4.7, 5.3]])]));
    put('lv-1/opening.csv', 'id,host_id,top_level_id,top_offset\nop-9,,lv-2,0.5\n');
    put('lv-1/opening.geojson', fc([poly('op-9', [[14, 14], [16, 14], [16, 16], [14, 16]])]));
    r = clashReport(dir);
    expect(r.clashes).toEqual([]);
    // --level keeps only that level's MEP
    expect(clashReport(dir, { level: 'lv-2' }).clashes).toEqual([]);
  });

  it('walls: structural = high, partitions = low unless a door or opening takes the run through', () => {
    put('lv-1/structure_wall.csv', 'id,thickness\nsw-1,0.25\n');
    put('lv-1/structure_wall.geojson', fc([line('sw-1', [0, 0], [0, 10])]));
    put('lv-1/wall.csv', 'id,thickness\nw-1,0.1\nw-2,0.1\n');
    put('lv-1/wall.geojson', fc([line('w-1', [6, 0], [6, 10]), line('w-2', [8, 0], [8, 10])]));
    put('lv-1/door.csv', 'id,host_id,position,width,height\nd-1,w-2,5,1,2.1\n');
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\ndu-1,rect,0.4,0.3,SA,,\ndu-2,rect,0.4,0.3,SA,,\n');
    // du-1 at 2.6 m crosses all three walls; du-2 at 1 m goes through the door in w-2 only
    put('lv-1/duct.geojson', fc([line('du-1', [-2, 3, 2.6], [10, 3, 2.6]), line('du-2', [7, 5, 1], [9, 5, 1])]));
    const r = clashReport(dir);
    const got = r.clashes.map(c => `${c.a}+${c.b}:${c.severity}:${c.kind}`).sort();
    expect(got).toEqual(['du-1+sw-1:high:hard', 'du-1+w-1:low:penetration', 'du-1+w-2:low:penetration']);
  });

  it('a duct ending on its equipment is connected; one passing through other equipment clashes', () => {
    put('lv-1/equipment.csv', 'id,number,system_type,equipment_type\neq-1,AHU-1,SA,ahu\neq-2,P-1,CHWS,pump\n');
    put('lv-1/equipment.geojson', fc([point('eq-1', [0, 0, 0], { size: [2, 1, 1.4] }), point('eq-2', [5, 0, 0.5], { size: [0.6, 0.6, 0.8] })]));
    put('lv-1/connector.csv', 'id,host_id,name,offset_x,offset_y,offset_z\ncn-1,eq-1,sa,1,0,0.7\n');
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\ndu-1,rect,0.4,0.3,SA,eq-1:sa,\n');
    put('lv-1/duct.geojson', fc([line('du-1', [1, 0, 0.7], [8, 0, 0.7])]));
    const r = clashReport(dir);
    expect(r.clashes.map(c => `${c.a}+${c.b}:${c.severity}`)).toEqual(['du-1+eq-2:medium']);
  });

  it('columns, tolerance and clearance', () => {
    put('lv-1/structure_column.csv', 'id,shape,size_x,size_y\nsc-1,rect,0.4,0.4\n');
    put('lv-1/structure_column.geojson', fc([point('sc-1', [5, 0])]));
    put('lv-1/pipe.csv', 'id,shape,size_x,size_y,system_type,from,to\npi-1,round,0.1,,DCW,,\npi-2,round,0.1,,DCW,,\n');
    // pi-1 grazes the column face by 5 mm; pi-2 passes 30 mm clear of it
    put('lv-1/pipe.geojson', fc([line('pi-1', [0, 0.245, 2], [10, 0.245, 2]), line('pi-2', [0, -0.28, 2], [10, -0.28, 2])]));
    expect(clashReport(dir).clashes).toEqual([]);
    expect(clashReport(dir, { toleranceMm: 1 }).clashes.map(c => c.a)).toEqual(['pi-1']);
    const r = clashReport(dir, { clearanceMm: 50 });
    expect(r.clashes.map(c => `${c.a}:${c.kind}`).sort()).toEqual(['pi-1:clearance', 'pi-2:clearance']);
    const gap = r.clashes.find(c => c.a === 'pi-2')!.depth;
    expect(gap).toBeGreaterThan(0.025);
    expect(gap).toBeLessThan(0.035);
  });
});

describe('detectClashes core', () => {
  const pipe = (id: string, a: [number, number, number], b: [number, number, number], d: number, system: string, extra: Partial<ClashCurveIn> = {}): ClashCurveIn =>
    ({ id, table: 'pipe', a, b, shape: 'round', w: d, h: d, system, ...extra });

  it('diagonal round pipes are tested exactly (no box corners)', () => {
    // Two Ø100 pipes at 45° in plan, 120 mm apart vertically: clear.
    const m = { curves: [pipe('a', [0, 0, 0], [10, 10, 0], 0.1, 'X'), pipe('b', [10, 0, 0.12], [0, 10, 0.12], 0.1, 'Y')], hosts: [] };
    expect(detectClashes(m)).toEqual([]);
    const near = { curves: [pipe('a', [0, 0, 0], [10, 10, 0], 0.1, 'X'), pipe('b', [10, 0, 0.07], [0, 10, 0.07], 0.1, 'Y')], hosts: [] };
    const [c] = detectClashes(near);
    expect(c.depth).toBeCloseTo(0.03, 3);
    expect(c.at[0]).toBeCloseTo(5, 2);
    expect(c.at[1]).toBeCloseTo(5, 2);
  });

  it('insulation counts; an elbow pair and a short offset are connected', () => {
    const bare = { curves: [pipe('a', [0, 0, 0], [10, 0, 0], 0.1, 'X'), pipe('b', [5, -5, 0.11], [5, 5, 0.11], 0.1, 'Y')], hosts: [] };
    expect(detectClashes(bare)).toEqual([]);
    bare.curves[0].insulation = 0.025;
    expect(detectClashes(bare)).toHaveLength(1);
    const elbow = { curves: [pipe('a', [0, 0, 0], [5, 0, 0], 0.3, 'X'), pipe('b', [5, 0, 0], [5, 0.2, 0], 0.3, 'X'), pipe('c', [5, 0.2, 0], [9, 0.2, 0], 0.3, 'X')], hosts: [] };
    expect(detectClashes(elbow)).toEqual([]);
  });

  it('a run crossing exactly at another run\'s fitting is not "tapped in"', () => {
    // SA trunk split at mn-2 (both halves reference it); an unassigned duct passes straight through that point.
    const curves: ClashCurveIn[] = [
      { id: 'du-3', table: 'duct', a: [23.8, 4.2, 3], b: [20, 4.2, 3], shape: 'rect', w: 0.35, h: 0.2, system: 'SA', from: 'mn-2', to: 'mn-7' },
      { id: 'du-7', table: 'duct', a: [27, 4.2, 3], b: [23.8, 4.2, 3], shape: 'rect', w: 0.35, h: 0.2, system: 'SA', from: 'mn-5', to: 'mn-2' },
      { id: 'du-21', table: 'duct', a: [23.8, 2.4, 3], b: [23.8, 5.4, 3], shape: 'rect', w: 0.4, h: 0.3, system: '' },
    ];
    // One clash, not one per trunk half: the trunk is split right where it crosses
    const got = detectClashes({ curves, hosts: [] }).map(c => [c.b, c.severity].join(':'));
    expect(got).toEqual(['du-21:medium']);
    // The same duct ending on the trunk (open end on its body) is a tap.
    curves[2] = { ...curves[2], b: [23.8, 4.2, 3] };
    expect(detectClashes({ curves, hosts: [] })).toEqual([]);
  });

  it('is fast on a few thousand elements', () => {
    const curves: ClashCurveIn[] = [];
    for (let i = 0; i < 1500; i++) curves.push(pipe(`h${i}`, [0, i * 0.5, 3], [200, i * 0.5, 3], 0.1, 'A'));
    for (let i = 0; i < 1500; i++) curves.push(pipe(`v${i}`, [i * 0.13, 0, 3.5], [i * 0.13, 10, 3.5], 0.1, 'B'));
    const t = Date.now();
    detectClashes({ curves, hosts: [] });
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
