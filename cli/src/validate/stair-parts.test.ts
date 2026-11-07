import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';

const testDir = join(__dirname, 'test-stair-parts');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('validate — multi-run stairs (stair_run, stair_landing)', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts runs (3D lines) and a landing (polygon) hosted on a stair', () => {
    mkdirSync(join(testDir, 'global'), { recursive: true });
    mkdirSync(join(testDir, 'lv-1'), { recursive: true });
    writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }));
    writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n');
    writeFileSync(join(testDir, 'lv-1', 'stair.csv'), 'id,number,width,step_count,top_level_id,stair_type\nst-1,S1,1.0,20,lv-2,half_turn\n');
    writeFileSync(join(testDir, 'lv-1', 'stair_run.csv'), 'id,number,host_id,width,step_count\nsr-1,,st-1,1,10\nsr-2,,st-1,1,10\n');
    writeFileSync(join(testDir, 'lv-1', 'stair_run.geojson'), fc([
      { type: 'Feature', properties: { id: 'sr-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 0], [3, 0, 1.8]] } },
      { type: 'Feature', properties: { id: 'sr-2' }, geometry: { type: 'LineString', coordinates: [[3, 1.2, 1.8], [0, 1.2, 3.6]] } },
    ]));
    writeFileSync(join(testDir, 'lv-1', 'stair_landing.csv'), 'id,number,base_offset,host_id,thickness\nsl_land-1,,1.8,st-1,0.2\n');
    writeFileSync(join(testDir, 'lv-1', 'stair_landing.geojson'), fc([
      { type: 'Feature', properties: { id: 'sl_land-1' }, geometry: { type: 'Polygon', coordinates: [[[3, -0.5], [4, -0.5], [4, 1.7], [3, 1.7], [3, -0.5]]] } },
    ]));
    expect(validate(testDir)).toEqual([]);
  });
});
