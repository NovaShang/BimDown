import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { build } from '../build/index.js';

const testDir = join(__dirname, 'test-groups');
const GROUP_HEADER = 'id,name,x,y,rotation,mirrored\n';
const COLUMN_HEADER = 'id,number,shape,size_x,size_y,group_id,pinned\n';

function column(id: string, x: number, y: number) {
  return { type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [x, y] } };
}

function setup(files: Record<string, string>) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  mkdirSync(join(testDir, 'lv-2'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\n');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(testDir, path), text);
}

function columns(level: string, rows: [string, number, number, string][]) {
  return {
    [`${level}/column.csv`]: COLUMN_HEADER + rows.map(([id, , , g]) => `${id},,rect,0.4,0.4,${g},`).join('\n') + '\n',
    [`${level}/column.geojson`]: JSON.stringify({ type: 'FeatureCollection', features: rows.map(([id, x, y]) => column(id, x, y)) }),
  };
}

describe('validate — model groups', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts grouped members, pinned elements and pinned grids', () => {
    setup({
      'lv-1/model_group.csv': GROUP_HEADER + 'mg-1,Bay,0,0,0,\nmg-2,Bay,10,0,90,true\n',
      ...columns('lv-1', [['c-1', 0, 0, 'mg-1'], ['c-2', 10, 0, 'mg-2'], ['c-3', 20, 0, '']]),
      'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y,pinned\ngr-1,A,0,0,0,10,true\n',
    });
    expect(validate(testDir)).toEqual([]);
    expect(build(testDir).warnings.filter(w => w.includes('model group'))).toEqual([]);
  });

  it('rejects members of a group on another level, empty groups and global groups', () => {
    setup({
      'lv-1/model_group.csv': GROUP_HEADER + 'mg-1,Bay,0,0,0,\nmg-2,Empty,0,0,x,\n',
      ...columns('lv-2', [['c-1', 0, 0, 'mg-1']]),
      'global/model_group.csv': GROUP_HEADER + 'mg-9,G,0,0,0,\n',
    });
    const issues = validate(testDir);
    expect(issues).toContain('lv-2/column.csv:2  group_id "mg-1" is not a model_group on lv-2');
    expect(issues).toContain('lv-1/model_group.csv:3  model group "mg-2" has no members (no element has group_id=mg-2)');
    expect(issues).toContain('lv-1/model_group.csv:3  rotation="x" is not a number');
    expect(issues.some(i => i.startsWith('global/model_group.csv  model groups belong to a level'))).toBe(true);
  });

  it('rejects a bad pinned value', () => {
    setup({ ...columns('lv-1', [['c-1', 0, 0, '']]) });
    writeFileSync(join(testDir, 'lv-1/column.csv'), COLUMN_HEADER + 'c-1,,rect,0.4,0.4,,yes\n');
    expect(validate(testDir).some(i => i.includes('field "pinned" value "yes" is not a valid enum'))).toBe(true);
  });

  it('warns when instances of one group diverge', () => {
    setup({
      'lv-1/model_group.csv': GROUP_HEADER + 'mg-1,Bay,0,0,0,\nmg-2,Bay,10,0,0,\n',
      ...columns('lv-1', [['c-1', 0, 0, 'mg-1'], ['c-2', 1, 0, 'mg-1'], ['c-3', 10, 0, 'mg-2']]),
    });
    expect(validate(testDir)).toEqual([]);
    expect(build(testDir).warnings).toContain('model group "Bay": lv-1/mg-2 (1 column) differs from lv-1/mg-1 (2 column)');
  });
});
