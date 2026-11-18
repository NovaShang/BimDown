import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';
import { loadStairs } from '../stair/model.js';
import { stairCalc, totalRisers, winderGeometry } from '../stair/geometry.js';

const testDir = join(__dirname, 'test-stair-shapes');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

function project() {
  const lv = join(testDir, 'lv-1');
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.06\n');
  mkdirSync(join(testDir, 'lv-2'), { recursive: true });
  return lv;
}

describe('curved and winder stairs', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('curved stair: the GeoJSON arc is the walking line (length, going, wedge treads in render)', () => {
    const lv = project();
    // r = 3 m walking line, 18 risers × 0.28 m = 5.04 m → 96.3°
    const sweep = 5.04 / 3;
    const end = [3 * Math.cos(sweep), 3 * Math.sin(sweep)];
    writeFileSync(join(lv, 'stair.csv'), 'id,number,width,step_count,stair_type,top_level_id\nst-1,S1,1.2,18,curved,lv-2\n');
    writeFileSync(join(lv, 'stair.geojson'), fc([{ type: 'Feature', properties: { id: 'st-1', arc: { radius: 3, large_arc: false, sweep: true } }, geometry: { type: 'LineString', coordinates: [[3, 0, 0], [end[0], end[1], 3.06]] } }]));
    expect(validate(testDir)).toEqual([]);
    const r = build(testDir);
    expect(r.issues).toEqual([]);
    expect(r.warnings.filter(w => w.includes('stair'))).toEqual([]);
    const s = loadStairs(testDir).find(d => d.dir === 'lv-1')!.stairs[0];
    expect(s.asm.runs[0].arc).toBeDefined();
    expect(Math.hypot(s.asm.runs[0].arc!.cx, s.asm.runs[0].arc!.cy)).toBeLessThan(1e-6);
    expect(stairCalc(s.asm)!.going).toBeCloseTo(0.28, 4);
    const svg = renderLevel(testDir, 'lv-1');
    // 17 tread lines + many stringer pieces along the arcs
    expect((svg.match(/<line /g) ?? []).length).toBeGreaterThan(40);
  });

  it('winder landing: step_count winders counted in the riser rule and drawn as risers', () => {
    const lv = project();
    // L: 7 + 3 winders + 8 = 18 risers of 0.17 m
    writeFileSync(join(lv, 'stair.csv'), 'id,number,width,step_count,stair_type,top_level_id\nst-1,S1,1.2,7,winder,lv-2\n');
    writeFileSync(join(lv, 'stair.geojson'), fc([{ type: 'Feature', properties: { id: 'st-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 0], [1.96, 0, 1.19]] } }]));
    writeFileSync(join(lv, 'stair_run.csv'), 'id,number,host_id,width,step_count\nsr-1,,st-1,1.2,8\n');
    writeFileSync(join(lv, 'stair_run.geojson'), fc([{ type: 'Feature', properties: { id: 'sr-1' }, geometry: { type: 'LineString', coordinates: [[2.56, 0.6, 1.7], [2.56, 2.84, 3.06]] } }]));
    writeFileSync(join(lv, 'stair_landing.csv'), 'id,number,base_offset,host_id,thickness,step_count\nsl_land-1,,1.19,st-1,0.15,3\n');
    writeFileSync(join(lv, 'stair_landing.geojson'), fc([{ type: 'Feature', properties: { id: 'sl_land-1' }, geometry: { type: 'Polygon', coordinates: [[[1.96, -0.6], [3.16, -0.6], [3.16, 0.6], [1.96, 0.6], [1.96, -0.6]]] } }]));
    expect(validate(testDir)).toEqual([]);
    const r = build(testDir);
    expect(r.issues).toEqual([]);
    expect(r.warnings.filter(w => w.includes('stair'))).toEqual([]);
    const s = loadStairs(testDir).find(d => d.dir === 'lv-1')!.stairs[0];
    expect(totalRisers(s.asm)).toBe(18);
    const w = winderGeometry(s.asm, s.asm.landings[0])!;
    expect(w.treads).toHaveLength(3);
    expect(w.lines).toHaveLength(2);
    expect(stairCalc(s.asm)!.riser).toBeCloseTo(0.17, 4);
  });
});
