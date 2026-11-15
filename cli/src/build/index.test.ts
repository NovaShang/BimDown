import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, validateOnly } from './index.js';

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
  it('warns about overlapping doors / windows (not stacked ones) and overlapping walls', () => {
    const lv = setup();
    writeFileSync(join(lv, 'door.csv'), 'id,number,host_id,position,width,height\nd-1,,w-1,2,0.9,2.1\nd-2,,w-1,2.4,0.9,2.1\n');
    // w-1-high sits over the door (sill 2.2): stacked, not overlapping
    writeFileSync(join(lv, 'window.csv'), 'id,number,host_id,position,width,height,base_offset\nwn-1,,w-1,2,0.9,0.6,2.2\nwn-2,,w-3,5,1.2,1.2,0.9\n');
    const walls = JSON.parse(readFileSync(join(lv, 'wall.geojson'), 'utf-8'));
    walls.features.push(line('w-5', [3, 0.05], [8, 0.05]), line('w-6', [3, 0.25], [8, 0.25]));
    writeFileSync(join(lv, 'wall.geojson'), JSON.stringify(walls));
    writeFileSync(join(lv, 'wall.csv'), 'id,number,thickness,material\nw-1,,0.2,concrete\nw-2,,0.2,concrete\nw-3,,0.2,concrete\nw-4,,0.2,concrete\nw-5,,0.1,concrete\nw-6,,0.1,concrete\n');
    const result = build(testDir);
    const overlaps = result.warnings.filter((w) => w.includes(' overlap '));
    expect(overlaps.some((w) => w.includes('d-1 and d-2 overlap on w-1'))).toBe(true);
    expect(overlaps.some((w) => w.includes('wn-1'))).toBe(false);
    expect(overlaps.some((w) => w.includes('w-1 and w-5 overlap for 5.000 m'))).toBe(true);
    expect(overlaps.some((w) => w.includes('w-6'))).toBe(false);
  });
});

describe('validate is read-only', () => {
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('reports what build reports, writes nothing', () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    const lv = setup();
    writeFileSync(join(lv, 'space.csv'), 'id,number,x,y,name\nsp-1,,2.5,1,A\n');
    // A wall end 3 cm off its corner: build snaps it
    writeFileSync(join(lv, 'wall.geojson'), readFileSync(join(lv, 'wall.geojson'), 'utf-8').replace('[0,5],[0,0]', '[0,5],[0.03,0]'));
    const snapshot = () => Object.fromEntries(readdirSync(lv).map(f => [f, readFileSync(join(lv, f), 'utf-8')]));
    const before = snapshot();
    const v = validateOnly(testDir);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(lv, 'space.geojson'))).toBe(false);
    const b = build(testDir);
    expect(v.issues).toEqual(b.issues);
    expect(v.warnings).toEqual(b.warnings);
    expect(v.snaps.length).toBe(b.snaps.length);
    expect(existsSync(join(lv, 'space.geojson'))).toBe(true);
  });
});
