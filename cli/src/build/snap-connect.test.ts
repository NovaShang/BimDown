import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './index.js';

const dir = join(__dirname, 'test-snap-connect');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) =>
  ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

function writeLevel(level: string, walls: [string, number[], number[], number][], columns: [string, number, number, number][] = []) {
  mkdirSync(join(dir, level), { recursive: true });
  writeFileSync(join(dir, level, 'wall.csv'),
    'id,number,base_level_id,top_level_id,material,thickness\n' + walls.map(([id, , , t]) => `${id},,${level},,concrete,${t}`).join('\n') + '\n');
  writeFileSync(join(dir, level, 'wall.geojson'), fc(walls.map(([id, a, b]) => line(id, a, b))));
  if (columns.length) {
    writeFileSync(join(dir, level, 'structure_column.csv'),
      'id,number,base_level_id,top_level_id,material,shape,size_x,size_y\n' + columns.map(([id, , , s]) => `${id},,${level},,concrete,rect,${s},${s}`).join('\n') + '\n');
    writeFileSync(join(dir, level, 'structure_column.geojson'),
      fc(columns.map(([id, x, y]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [x, y] } }))));
  }
}

describe('build: endpoint snapping and wall connectivity', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,4\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('treats T-junctions at the wall face and wall ends on columns as connected', () => {
    writeLevel('lv-1', [
      ['w-1', [0, 0], [10, 0], 0.3],
      ['w-2', [5, 0.15], [5, 4], 0.2],      // ends on the face of w-1
      ['w-3', [0, 0], [0, 4], 0.3],
      ['w-4', [0, 4], [5, 4], 0.2],
      ['w-5', [10.3, 0], [14, 0], 0.3],     // starts at the face of column c-1 (10,0); its far end is free
    ], [['sc-1', 10, 0, 0.6]]);
    const r = build(dir);
    const free = r.warnings.filter((w) => w.includes('no connected line element'));
    expect(free.some((w) => w.includes('w-2 start'))).toBe(false);
    expect(free.some((w) => w.includes('w-5 start'))).toBe(false);
    expect(free.some((w) => w.includes('w-5 end'))).toBe(true);
  });

  it('snaps only near-coincident ends, per level, and never far ones', () => {
    writeLevel('lv-1', [
      ['w-1', [0, 0], [5, 0], 0.5],
      ['w-2', [5.03, 0.02], [5, 6], 0.5],   // 3.6 cm from w-1 end → merged
      ['w-3', [5.3, 0], [9, 0], 0.5],       // 30 cm away → left alone, even with 0.5 m thick walls
    ]);
    writeLevel('lv-2', [['w-1', [5.01, 0], [5.01, 6], 0.2]]);  // other level: must not snap to lv-1
    const r = build(dir);
    expect(r.snaps.length).toBe(1);
    expect(r.snaps[0].level).toBe('lv-1');
    const g1 = JSON.parse(readFileSync(join(dir, 'lv-1', 'wall.geojson'), 'utf-8'));
    expect(g1.features[2].geometry.coordinates[0]).toEqual([5.3, 0]);
    const g2 = JSON.parse(readFileSync(join(dir, 'lv-2', 'wall.geojson'), 'utf-8'));
    expect(g2.features[0].geometry.coordinates[0]).toEqual([5.01, 0]);
  });
});

describe('build: tolerances follow the project units', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'ft' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,12\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('merges ends within 5 cm (0.164 ft) in a feet project, not within 0.05 ft only', () => {
    writeLevel('lv-1', [
      ['w-1', [0, 0], [20, 0], 0.67],
      ['w-2', [20.1, 0.05], [20, 15], 0.67],  // 0.11 ft = 3.4 cm → merged
      ['w-3', [21, 0], [30, 0], 0.67],        // 1 ft away → left alone
    ]);
    const r = build(dir);
    expect(r.snaps.length).toBe(1);
    expect(r.snaps[0].elementId).toBe('w-2');
  });

  it('resolves host_x/host_y within 5 cm and reports the tolerance in project units', () => {
    writeLevel('lv-1', [['w-1', [0, 0], [20, 0], 0.67]]);
    writeFileSync(join(dir, 'lv-1', 'door.csv'), 'id,number,host_x,host_y,width,height\nd-1,P01,10,0.1,3,7\nd-2,P02,15,1,3,7\n');
    const r = build(dir);
    const door = readFileSync(join(dir, 'lv-1', 'door.csv'), 'utf-8');
    expect(door).toMatch(/d-1,w-1,10\.0000/);
    expect(r.issues.some((i) => i.includes('d-2') && i.includes('within 0.164 ft'))).toBe(true);
  });

  it('checks GeoJSON coordinate ranges in the project units', () => {
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'mm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,4000\n');
    writeLevel('lv-1', [['w-1', [0, 0], [6000, 0], 200]]);
    expect(build(dir).issues.filter((i) => i.includes('out of range'))).toEqual([]);
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,1F,0\nlv-2,2,2F,4\n');
    writeLevel('lv-1', [['w-1', [0, 0], [6000, 0], 0.2]]);
    expect(build(dir).issues.some((i) => i.includes('coordinate 6000 is out of range for project units "m"'))).toBe(true);
  });
});
