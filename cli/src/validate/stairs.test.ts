import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';
import { loadStairs } from '../stair/model.js';
import { railPlan } from '../stair/geometry.js';

const testDir = join(__dirname, 'test-stairs');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** An L stair (lv-1 → lv-2, 3 m, 9 + 9 risers) with railings both sides; optional multi-storey top. */
function lStair(opts: { multistory?: string; stairCsv?: string; railingCsv?: string } = {}) {
  const lv = join(testDir, 'lv-1');
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-3,3,L3,6.5\n');
  mkdirSync(join(testDir, 'lv-2'), { recursive: true });
  mkdirSync(join(testDir, 'lv-3'), { recursive: true });
  writeFileSync(join(lv, 'stair.csv'), opts.stairCsv ?? `id,number,width,step_count,stair_type,top_level_id,multistory_top_level_id\nst-1,S1,1.2,9,quarter_turn,lv-2,${opts.multistory ?? ''}\n`);
  // 2.52 m runs: going 280 mm, riser 167 mm
  writeFileSync(join(lv, 'stair.geojson'), fc([line('st-1', [0, 0, 0], [2.52, 0, 1.5])]));
  writeFileSync(join(lv, 'stair_run.csv'), 'id,number,host_id,width,step_count\nsr-1,,st-1,1.2,9\n');
  writeFileSync(join(lv, 'stair_run.geojson'), fc([line('sr-1', [3.12, 0.6, 1.5], [3.12, 3.12, 3])]));
  writeFileSync(join(lv, 'stair_landing.csv'), 'id,number,base_offset,host_id,thickness\nsl_land-1,,1.5,st-1,0.2\n');
  writeFileSync(join(lv, 'stair_landing.geojson'), fc([{ type: 'Feature', properties: { id: 'sl_land-1' }, geometry: { type: 'Polygon', coordinates: [[[2.52, -0.6], [3.72, -0.6], [3.72, 0.6], [2.52, 0.6], [2.52, -0.6]]] } }]));
  writeFileSync(join(lv, 'railing.csv'), opts.railingCsv ?? 'id,number,host_id,side,height\nrl-1,,st-1,left,\nrl-2,,st-1,right,1.0\n');
  return lv;
}

describe('stairs and railings', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts an L stair with stair railings (no railing geometry) and a slab-edge railing', () => {
    const lv = lStair();
    writeFileSync(join(lv, 'slab.csv'), 'id,number,thickness\nsl-1,,0.2\n');
    writeFileSync(join(lv, 'slab.geojson'), fc([{ type: 'Feature', properties: { id: 'sl-1' }, geometry: { type: 'Polygon', coordinates: [[[5, 0], [9, 0], [9, 4], [5, 4], [5, 0]]] } }]));
    writeFileSync(join(lv, 'railing.csv'), 'id,number,host_id,side,height\nrl-1,,st-1,left,\nrl-2,,st-1,right,1.0\nrl-3,,sl-1,,1.1\n');
    writeFileSync(join(lv, 'railing.geojson'), fc([line('rl-3', [5, 4, 0], [9, 4, 0])]));
    expect(validate(testDir)).toEqual([]);
    const r = build(testDir);
    expect(r.issues).toEqual([]);
    expect(r.warnings.filter(w => w.includes('stair') || w.includes('railing'))).toEqual([]);
  });

  it('derives the stair railings along the runs and round the landing', () => {
    lStair();
    const d = loadStairs(testDir).find(x => x.dir === 'lv-1')!;
    const outer = d.railings.find(r => r.id === 'rl-2')!;
    const plan = railPlan(outer.paths[0]);
    expect(plan.some(p => Math.abs(p.x - 3.67) < 1e-6 && Math.abs(p.y + 0.55) < 1e-6)).toBe(true);
    const inner = railPlan(d.railings.find(r => r.id === 'rl-1')!.paths[0]);
    expect(inner.some(p => Math.abs(p.x - 2.57) < 1e-6 && Math.abs(p.y - 0.55) < 1e-6)).toBe(true);
  });

  it('warns with the stair calculator', () => {
    const lv = lStair();
    writeFileSync(join(lv, 'stair.csv'), 'id,number,width,step_count,stair_type\nst-1,S1,0.8,6,quarter_turn\n');
    writeFileSync(join(lv, 'stair_run.csv'), 'id,number,host_id,width,step_count\nsr-1,,st-1,0.8,6\n');
    const w = build(testDir).warnings.join('\n');
    expect(w).toMatch(/st-1 {2}riser 250 mm outside 150 mm–190 mm/);
    expect(w).toMatch(/st-1 {2}width 800 mm below 900 mm/);
    expect(validate(testDir)).toEqual([]); // advisory only
  });

  it('checks every storey of a multi-storey stair and its top level', () => {
    lStair({ multistory: 'lv-3' });
    const d = loadStairs(testDir).find(x => x.dir === 'lv-1')!;
    expect(d.stairs[0].reps.map(r => r.levelId)).toEqual(['lv-1', 'lv-2']);
    expect(d.railings[0].paths).toHaveLength(2);
    // 3.5 m storey / 18 risers = 194 mm on the second storey
    expect(build(testDir).warnings.join('\n')).toMatch(/riser 194 mm outside .*2 storeys/);
    lStair({ multistory: 'lv-1' });
    expect(validate(testDir).join('\n')).toMatch(/multistory_top_level_id "lv-1" must be a level above/);
  });

  it('reports railings on a missing host or a stair railing without a side', () => {
    lStair({ railingCsv: 'id,number,host_id,side\nrl-1,,st-1,\nrl-2,,w-9,\n' });
    const issues = validate(testDir).join('\n');
    expect(issues).toMatch(/rl-1 {2}a railing on a stair needs side/);
    expect(issues).toMatch(/rl-2 {2}host_id "w-9" must be a stair or a slab/);
  });

  it('warns about a sketched railing without geometry unless it has a mesh', () => {
    lStair({ railingCsv: 'id,number,host_id,side,mesh_file\nrl-1,,st-1,left,\nrl-2,,,,\nrl-3,,,,mesh/rl-3.glb\n' });
    const warnings = build(testDir).warnings.filter(w => w.includes('no geometry'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/rl-2 {2}no geometry/);
  });

  it('renders runs, landings, the walking line and the derived railings; repetitions on upper storeys', () => {
    lStair({ multistory: 'lv-3' });
    const svg = renderLevel(testDir, 'lv-1');
    expect(svg).toContain('<g id="st-1">');
    expect(svg).toContain('>UP</text>');
    expect(svg).toMatch(/<polyline id="rl-1"/);
    expect(svg).toMatch(/<polyline id="rl-2"/);
    expect(svg).toContain('stroke-dasharray'); // treads beyond the cut
    const upper = renderLevel(testDir, 'lv-2');
    expect(upper).toContain('<g id="st-1">');
    expect(upper).toMatch(/<polyline id="rl-2"/);
    expect(renderLevel(testDir, 'lv-3')).not.toContain('<g id="st-1">');
  });

  it('renders a level that has no directory of its own (stair repetitions on it)', () => {
    lStair({ multistory: 'lv-3' });
    rmSync(join(testDir, 'lv-2'), { recursive: true, force: true });
    const upper = renderLevel(testDir, 'lv-2');
    expect(upper).toContain('<g id="st-1">');
    expect(() => renderLevel(testDir, 'lv-9')).toThrow(/Available: .*lv-2/);
  });
});
