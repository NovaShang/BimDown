import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';

const testDir = join(__dirname, 'test-ranges');

describe('validate — numeric sign rules (shared with the editor)', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'global'), { recursive: true });
    mkdirSync(join(testDir, 'lv-1'), { recursive: true });
    writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
    writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects a negative or zero thickness and width; empty values are left to the other checks', () => {
    writeFileSync(join(testDir, 'lv-1', 'wall.csv'), 'id,number,thickness,material\nw-1,,-0.2,brick\nw-2,,0,brick\nw-3,,0.2,brick\n');
    writeFileSync(join(testDir, 'lv-1', 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: ['w-1', 'w-2', 'w-3'].map((id, i) => ({
      type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [[0, i], [5, i]] },
    })) }));
    writeFileSync(join(testDir, 'global', 'door_type.csv'), 'id,name,width,height\ndt-1,Bad,-0.9,2.1\ndt-2,Ok,0.9,\n');
    const issues = validate(testDir);
    expect(issues.some((i) => i.includes('wall.csv:2  thickness=-0.2 must be greater than 0'))).toBe(true);
    expect(issues.some((i) => i.includes('wall.csv:3  thickness=0 must be greater than 0'))).toBe(true);
    expect(issues.some((i) => i.includes('wall.csv:4'))).toBe(false);
    expect(issues.some((i) => i.includes('door_type.csv:2  width=-0.9 must be greater than 0'))).toBe(true);
    expect(issues.some((i) => i.includes('door_type.csv:3'))).toBe(false);
  });
});
