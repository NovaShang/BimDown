import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { renderLevel } from '../render.js';

const testDir = join(__dirname, 'test-envelope');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const poly = (id: string, ring: number[][], props: Record<string, unknown> = {}) =>
  ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];

function project(files: Record<string, string>) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  mkdirSync(join(testDir, 'lv-2'), { recursive: true });
  mkdirSync(join(testDir, 'lv-3'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-3,3,L3,6\n');
  for (const [p, c] of Object.entries(files)) writeFileSync(join(testDir, p), c);
}

describe('validate / render — roofs, wall attach, shafts', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  const valid = {
    'lv-1/wall.csv': 'id,thickness,top_level_id,top_attach_id\nw-1,0.2,lv-2,ro-1\n',
    'lv-1/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } }]),
    'lv-1/opening.csv': 'id,host_id,top_level_id,top_offset,base_offset\nop-1,,lv-3,0,0\nop-2,sl-2,,,\n',
    'lv-1/opening.geojson': fc([poly('op-1', [[1, 1], [2, 1], [2, 2], [1, 2]]), poly('op-2', [[6, 1], [7, 1], [7, 2], [6, 2]])]),
    'lv-1/slab.csv': 'id,thickness\nsl-2,0.2\n',
    'lv-1/slab.geojson': fc([poly('sl-2', [[0, 0], [10, 0], [10, 4], [0, 4]])]),
    'lv-2/slab.csv': 'id,thickness\nsl-1,0.2\n',
    'lv-2/slab.geojson': fc([poly('sl-1', L)]),
    'lv-2/roof.csv': 'id,roof_type,slope,edge_slopes,thickness\nro-1,gable,45,45;0;45;45;0;45,0.2\n',
    'lv-2/roof.geojson': fc([poly('ro-1', L, { base_offset: 3 })]),
  };

  it('accepts edge slopes, attached walls and a shaft without host', () => {
    project(valid);
    expect(validate(testDir)).toEqual([]);
  });

  it('reports wrong edge counts, bad attach targets, hostless openings and bad profiles', () => {
    project({
      ...valid,
      'lv-1/wall.csv': 'id,thickness,top_level_id,top_attach_id\nw-1,0.2,lv-2,op-2\n',
      'lv-1/opening.csv': 'id,host_id,top_level_id,top_offset,base_offset\nop-1,,lv-1,0,0\nop-2,,,,\n',
      'lv-2/roof.csv': 'id,roof_type,slope,edge_slopes,profile,thickness\nro-1,extrusion,45,45;0;45,0;1,0.2\n',
    });
    const issues = validate(testDir).join('\n');
    expect(issues).toMatch(/edge_slopes has 3 values but the roof outline has 6 edges/);
    expect(issues).toMatch(/top_attach_id "op-2" is a opening/);
    expect(issues).toMatch(/op-2|host_id is required/);
    expect(issues).toMatch(/shaft top \(lv-1\) must be above its base level/);
    expect(issues).toMatch(/extrusion roof needs profile/);
  });

  it('checks boundary_walls (floors / roofs picked from walls)', () => {
    project({ ...valid, 'lv-1/slab.csv': 'id,thickness,boundary_walls,boundary_face\nsl-2,0.2,w-1,core\n' });
    expect(validate(testDir)).toEqual([]);
    project({ ...valid, 'lv-1/slab.csv': 'id,thickness,boundary_walls,boundary_face\nsl-2,0.2,w-1;w-9;op-1,middle\n' });
    const issues = validate(testDir).join('\n');
    expect(issues).toMatch(/boundary_walls: "w-9" is not a wall on lv-1/);
    expect(issues).toMatch(/boundary_walls: "op-1" is a opening/);
    expect(issues).toMatch(/boundary_face/);
  });

  it('renders roof ridges, valleys and slope arrows, and shafts on the levels they cross', () => {
    project(valid);
    const roof = renderLevel(testDir, 'lv-2');
    // L-shaped gable: two ridges, a hip, a dashed valley, slope labels.
    expect((roof.match(/stroke-dasharray="0.25,0.12"/g) ?? []).length).toBe(1);
    expect(roof).toContain('45°');
    expect(roof).toContain('id="op-1"');
    expect(renderLevel(testDir, 'lv-3')).toContain('id="op-1"');
  });
});
