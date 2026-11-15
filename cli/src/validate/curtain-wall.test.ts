import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';
import { cellKinds, gridLines, parseNumberList, parsePanels } from '../curtain-grid.js';

const testDir = join(__dirname, 'test-curtain-wall');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

function project(csv: string) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n');
  writeFileSync(join(testDir, 'lv-1', 'curtain_wall.csv'), csv);
  writeFileSync(join(testDir, 'lv-1', 'curtain_wall.geojson'), fc([
    { type: 'Feature', properties: { id: 'cw-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [6, 0]] } },
  ]));
}

describe('curtain grid layout', () => {
  it('counts are cells, spacing applies only without a count, explicit lists win', () => {
    expect(gridLines('', '3', '', 6)).toEqual([2, 4]);
    expect(gridLines('', '', '1.5', 6)).toEqual([1.5, 3, 4.5]);
    expect(gridLines('', '', '', 6)).toEqual([2, 4]);
    expect(gridLines('', '0', '', 6)).toEqual([2, 4]); // as the editor always read it
    expect(gridLines('4.5; 1.2;9;1.2', '3', '', 6)).toEqual([1.2, 4.5]);
  });

  it('parses lists and panel rules', () => {
    expect(parseNumberList('1.2;x;2')).toEqual({ values: [1.2, 2], bad: ['x'] });
    const { rules, bad } = parsePanels('*:0=solid; 1:0=door;2,1=empty;oops');
    expect(bad).toEqual(['oops']);
    const k = cellKinds(rules, 3, 2);
    expect(k[0]).toEqual(['solid', 'glass']);
    expect(k[1]).toEqual(['door', 'glass']);
    expect(k[2]).toEqual(['solid', 'empty']);
  });
});

describe('validate / build — curtain wall grids and panels', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('accepts a non-uniform grid with door, solid and empty panels', () => {
    project('id,number,top_level_id,v_grids,u_grids,panels,mullion_profile\ncw-1,,lv-2,1.5;3.3;4.8,0.9;2.4,*:0=solid;1:0=door;3:2=empty,round\n');
    expect(validate(testDir)).toEqual([]);
    const r = build(testDir);
    expect(r.issues).toEqual([]);
    expect(r.warnings.filter((w) => w.includes('curtain_wall.csv'))).toEqual([]);
  });

  it('flags bad list syntax and unknown kinds', () => {
    project('id,number,v_grids,u_grids,panels,mullion_profile\ncw-1,,1.5;abc,,1:0=window;zz,oval\n');
    const issues = validate(testDir);
    expect(issues.some((i) => i.includes('v_grids') && i.includes('abc'))).toBe(true);
    expect(issues.some((i) => i.includes('panels') && i.includes('zz'))).toBe(true);
    expect(issues.some((i) => i.includes('unknown kind window'))).toBe(true);
    expect(issues.some((i) => i.includes('mullion_profile'))).toBe(true);
  });

  it('warns about lines outside the wall, cells outside the grid and raised doors', () => {
    project('id,number,top_level_id,v_grids,u_grids,panels\ncw-1,,lv-2,2;7,1;4,5:0=solid;0:1=door\n');
    const w = build(testDir).warnings.filter((x) => x.includes('curtain_wall.csv'));
    expect(w.some((x) => x.includes('v_grids 7'))).toBe(true);
    expect(w.some((x) => x.includes('u_grids 4'))).toBe(true);
    expect(w.some((x) => x.includes('5:0=solid'))).toBe(true);
    expect(w.some((x) => x.includes('row 0'))).toBe(true);
  });

  it('door panel marks: extra marks warn; a mark shared with a door warns as a duplicate number', () => {
    project('id,number,top_level_id,v_grid_count,u_grid_count,panels,door_numbers\ncw-1,,lv-2,3,2,1:0=door,D101;D102\n');
    writeFileSync(join(testDir, 'lv-1', 'wall.csv'), 'id,number,thickness\nw-1,,0.2\n');
    writeFileSync(join(testDir, 'lv-1', 'wall.geojson'), fc([{ type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 5], [8, 5]] } }]));
    writeFileSync(join(testDir, 'lv-1', 'door.csv'), 'id,number,host_id,position,width,height\nd-1,D101,w-1,2,0.9,2.1\n');
    expect(validate(testDir)).toEqual([]);
    const w = build(testDir).warnings;
    expect(w.some((x) => x.includes('door_numbers lists 2 marks for 1 door panel'))).toBe(true);
    expect(w.some((x) => x.includes('door number "D101" is used 2 times'))).toBe(true);
  });

  it('renders grid ticks and door swings', () => {
    project('id,number,v_grids,panels\ncw-1,,1.5;3.3,1:0=door\n');
    const svg = renderLevel(testDir, 'lv-1');
    const g = svg.split('\n').find((l) => l.includes('id="cw-1"'))!;
    // Two strip runs (the door cell is open), ticks at 0, 1.5, 3.3, 6 and one swing arc.
    expect(g.match(/<polygon/g)?.length).toBe(2);
    expect((g.match(/M [\d.-]+,[\d.-]+ L/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(g.match(/<polyline/g)?.length).toBe(1);
  });
});
