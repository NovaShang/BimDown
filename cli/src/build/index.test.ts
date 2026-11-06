import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './index.js';

const testDir = join(__dirname, 'test-build');

const line = (id: string, a: number[], b: number[]) => ({
  type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] },
});

function setup() {
  const lv = join(testDir, 'lv-1');
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  const walls = [
    line('w-1', [0, 0], [10, 0]), line('w-2', [10, 0], [10, 5]),
    line('w-3', [10, 5], [0, 5]), line('w-4', [0, 5], [0, 0]),
  ];
  writeFileSync(join(lv, 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: walls }));
  writeFileSync(join(lv, 'wall.csv'), 'id,number,thickness,material\n' + walls.map((w) => `${w.properties.id},,0.2,concrete`).join('\n') + '\n');
  writeFileSync(join(lv, 'beam.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [line('bm-1', [0, 2.5, 3], [10, 2.5, 3])] }));
  writeFileSync(join(lv, 'beam.csv'), 'id,number,shape,size_x,size_y,material\nbm-1,,rect,0.3,0.6,steel\n');
  return lv;
}

describe('build — room issues', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('reports overlapping rooms as warnings, not issues', () => {
    const lv = setup();
    writeFileSync(join(lv, 'space.csv'), 'id,number,x,y,name\nsp-1,,2.5,1,A\nsp-2,,7.5,4,B\n');
    const result = build(testDir);
    expect(result.issues).toEqual([]);
    expect(result.roomIssues).toEqual([{ kind: 'shared', level: 'lv-1', spaceIds: ['sp-1', 'sp-2'] }]);
    expect(result.warnings.some((w) => w.includes('sp-1, sp-2 share one enclosed area'))).toBe(true);
  });
});
