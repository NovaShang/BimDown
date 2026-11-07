import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { build } from '../build/index.js';

const testDir = join(__dirname, 'test-underlay');

const HEADER = 'id,name,level_id,file,page,x,y,rotation,scale,opacity,visible,locked,hidden_layers';

function writeUnderlays(rows: string[]) {
  writeFileSync(join(testDir, 'global', 'underlay.csv'), [HEADER, ...rows].join('\n') + '\n');
}

describe('underlay (global/underlay.csv + underlays/)', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'global'), { recursive: true });
    mkdirSync(join(testDir, 'lv-1'), { recursive: true });
    mkdirSync(join(testDir, 'underlays'), { recursive: true });
    writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm' }));
    writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
    writeFileSync(join(testDir, 'underlays', 'plan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(testDir, 'underlays', 'site.dxf'), '0\nEOF\n');
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts underlays/ and valid rows (including far-away DXF origins)', () => {
    writeUnderlays([
      'ul-1,Plan,lv-1,underlays/plan.png,1,-5,-3,0,0.02,0.5,true,false,',
      'ul-2,Site,lv-1,underlays/site.dxf,1,-350000,-4200000,12.5,0.001,0.6,false,true,DIM;TEXT',
    ]);
    expect(validate(testDir)).toEqual([]);
  });

  it('build ignores underlays', () => {
    writeUnderlays(['ul-1,Plan,lv-1,underlays/plan.png,1,0,0,0,0.02,0.5,true,false,']);
    const result = build(testDir);
    expect(result.issues).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it('reports missing files, paths outside underlays/ and unsupported types', () => {
    writeUnderlays([
      'ul-1,,lv-1,underlays/missing.png,1,0,0,0,1,0.5,true,false,',
      'ul-2,,lv-1,lv-1/wall.csv,1,0,0,0,1,0.5,true,false,',
      'ul-3,,lv-1,underlays/plan.dwg,1,0,0,0,1,0.5,true,false,',
    ]);
    expect(validate(testDir)).toEqual([
      'global/underlay.csv:2  file "underlays/missing.png" not found',
      'global/underlay.csv:3  file "lv-1/wall.csv" must be a path under underlays/',
      'global/underlay.csv:4  file "underlays/plan.dwg" is not a supported underlay type (.png, .jpg, .jpeg, .webp, .pdf, .dxf)',
    ]);
  });

  it('checks the level reference, id prefix and flags', () => {
    writeUnderlays(['x-1,,lv-9,underlays/plan.png,1,0,0,0,1,0.5,yes,false,']);
    const issues = validate(testDir);
    expect(issues.some((i) => i.includes('lv-9') && i.includes('non-existent'))).toBe(true);
    expect(issues.some((i) => i.includes('x-1'))).toBe(true);
    expect(issues.some((i) => i.includes('"visible" value "yes"'))).toBe(true);
  });

  it('underlay.csv belongs in global/ only', () => {
    writeFileSync(join(testDir, 'lv-1', 'underlay.csv'), `${HEADER}\n`);
    expect(validate(testDir)).toContain('lv-1/underlay.csv  underlay belongs in global/ only');
  });
});
