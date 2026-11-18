import { describe, it, expect, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSpecDir } from '../schema/registry.js';
import { authoringHints } from './hints.js';
import { build } from './index.js';
import { projectInfoLines } from '../commands/info.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Starter catalog + a level of walls / doors / beams written with raw sizes. */
function project(files: Record<string, string>, starter = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'bimdown-hints-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'global'));
  mkdirSync(join(dir, 'lv-1'));
  writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
  writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  if (starter) {
    const src = join(getSpecDir(), 'starter-types', 'global');
    for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dir, 'global', f));
  }
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
const walls = fc([line('w-1', [0, 0], [10, 0]), line('w-2', [10, 0], [10, 5]), line('w-3', [10, 5], [0, 5])]);

describe('authoring hints', () => {
  it('points raw walls / doors at the matching starter type and lists unmatched sizes', () => {
    const dir = project({
      'lv-1/wall.csv': 'id,thickness,material,type_id\nw-1,0.2,concrete,\nw-2,0.2,,\nw-3,0.17,,\n',
      'lv-1/wall.geojson': walls,
      'lv-1/door.csv': 'id,number,host_id,position,width,height,operation,material\nd-1,D101,w-1,2,0.9,2.1,single_swing,wood\n',
    });
    const hints = authoringHints(dir);
    const wall = hints.find((h) => h.startsWith('[hint] wall:'))!;
    expect(wall).toContain('3 row(s) without type_id');
    expect(wall).toContain('wt-concrete-200 ← 2 (lv-1/w-1, lv-1/w-2)');
    expect(wall).toMatch(/1 in 1 size\(s\) \[thickness: 0\.17 ×1\] — add a wall_type row/);
    expect(hints.find((h) => h.startsWith('[hint] door:'))).toContain('dt-single-900 ← 1');
  });

  it('suggests one new type per distinct section when the catalog has none that fit', () => {
    const beams = fc([1, 2, 3].map((i) => ({ type: 'Feature', properties: { id: `bm-${i}` }, geometry: { type: 'LineString', coordinates: [[0, i, 3], [6, i, 3]] } })));
    const dir = project({
      'lv-1/beam.csv': 'id,shape,size_x,size_y,material\nbm-1,rect,0.35,0.7,\nbm-2,rect,0.35,0.7,\nbm-3,rect,0.2,0.4,concrete\n',
      'lv-1/beam.geojson': beams,
    });
    const beam = authoringHints(dir).find((h) => h.startsWith('[hint] beam:'))!;
    expect(beam).toContain('3 in 2 size(s) [size_x×size_y: 0.35×0.7 ×2, 0.2×0.4 ×1]');
    expect(beam).toContain('add a beam_type row');
  });

  it('is silent for typed elements and flags unmarked doors / windows', () => {
    const dir = project({
      'lv-1/wall.csv': 'id,type_id\nw-1,wt-concrete-200\nw-2,wt-concrete-200\nw-3,wt-concrete-200\n',
      'lv-1/wall.geojson': walls,
      'lv-1/door.csv': 'id,number,host_id,position,type_id\nd-1,,w-1,2,dt-single-900\n',
    });
    const hints = authoringHints(dir);
    expect(hints.some((h) => h.startsWith('[hint] wall:'))).toBe(false);
    expect(hints).toEqual(['[hint] door: 1 row(s) without a number (mark: tags and schedules show it; unique project-wide): lv-1/d-1']);
    // hints ride along with build but are not warnings
    const result = build(dir);
    expect(result.hints).toEqual(hints);
    expect(result.warnings.some((w) => w.includes('[hint]'))).toBe(false);
  });
});

describe('projectInfoLines', () => {
  it('lists the type catalog with sizes and how many elements are typed', () => {
    const dir = project({
      'lv-1/wall.csv': 'id,type_id,thickness\nw-1,wt-concrete-200,\nw-2,,0.2\nw-3,,0.2\n',
      'lv-1/wall.geojson': walls,
    });
    const text = projectInfoLines(dir).join('\n');
    expect(text).toMatch(/^Units: m \(from project_metadata\.json\)/);
    expect(text).toContain('lv-1/  wall: 3');
    expect(text).not.toMatch(/global\/ .*wall_type/);
    expect(text).toMatch(/ {2}wall_type: wt-concrete-200 \(0\.2\), /);
    expect(text).toMatch(/ {2}door_type: dt-single-900 \(0\.9×2\.1\)/);
    expect(text).toMatch(/ {2}beam_type: bmt-concrete-250x500 \(0\.25×0\.5\)/);
    expect(text).toContain('  typed: wall 1/3');
  });

  it('says so when the project has no types', () => {
    expect(projectInfoLines(project({}, false)).join('\n')).toContain('Types: none');
  });
});
