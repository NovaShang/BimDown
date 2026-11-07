import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';

const testDir = join(__dirname, 'test-view');
const HEADER = 'id,name,view_type,start_x,start_y,end_x,end_y,depth\n';

function setup(viewCsv: string, dir = 'global') {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  writeFileSync(join(testDir, dir, 'view.csv'), HEADER + viewCsv);
}

describe('validate — global/view.csv (saved section views)', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts section rows with and without a far-clip depth', () => {
    setup('vw-1,Section A,section,0,5,30,5,\nvw-2,,section,10,0,10,20,8\n');
    expect(validate(testDir)).toEqual([]);
  });

  it('rejects unknown view types, bad ids and missing line coordinates', () => {
    setup('x-1,Bad,plan,0,5,30,5,\nvw-2,,section,,0,10,20,\n');
    const issues = validate(testDir);
    expect(issues.some((i) => i.includes('id "x-1" has wrong format, expected "vw-..."'))).toBe(true);
    expect(issues.some((i) => i.includes('"view_type" value "plan" is not a valid enum'))).toBe(true);
    expect(issues.some((i) => i.includes('start_x'))).toBe(true);
  });

  it('only lives in global/', () => {
    setup('vw-1,A,section,0,0,1,0,\n', 'lv-1');
    expect(validate(testDir)).toContain('lv-1/view.csv  view belongs in global/ only');
  });
});
