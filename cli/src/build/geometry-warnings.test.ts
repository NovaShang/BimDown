import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGeometry } from './geometry-warnings.js';

const line = (id: string, a: number[], b: number[]) => ({
  type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] },
});

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** A dangling wall, a wall inside another, two overlapping doors and a door past its wall's end. */
function project(units: string): string {
  dir = mkdtempSync(join(tmpdir(), 'bimdown-geo-'));
  const lv = join(dir, 'lv-1');
  mkdirSync(join(dir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units }));
  writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  const walls = [line('w-1', [0, 0], [30, 0]), line('w-2', [5, 0], [20, 0]), line('w-3', [40, 10], [50, 10])];
  writeFileSync(join(lv, 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: walls }));
  writeFileSync(join(lv, 'wall.csv'), 'id,thickness\nw-1,0.67\nw-2,0.67\nw-3,0.67\n');
  writeFileSync(join(lv, 'door.csv'), 'id,host_id,position,width,height\nd-1,w-1,10,3,7\nd-2,w-1,11,3,7\nd-3,w-3,9.5,3,7\n');
  return dir;
}

describe('geometry warnings use the project unit', () => {
  it('labels distances in ft for a feet project', () => {
    const w = validateGeometry(project('ft')).join('\n');
    expect(w).toMatch(/has no connected line element \(nearest: .*distance [\d.]+ ft\)/);
    expect(w).toMatch(/d-1 and d-2 overlap on w-1 \(d-1: [\d.]+–[\d.]+ ft/);
    expect(w).toMatch(/w-\d and w-\d overlap for [\d.]+ ft/);
    expect(w).toMatch(/d-3 extends past host w-3 end: .* ft > wall length 10\.000 ft/);
    expect(w).not.toMatch(/\dm\b|\d m\b/);
  });

  it('keeps m in a metre project', () => {
    const w = validateGeometry(project('m')).join('\n');
    expect(w).toMatch(/distance [\d.]+ m\)/);
    expect(w).not.toMatch(/ ft\b/);
  });
});

describe('dormer cheek walls', () => {
  it('a wall ending on the edge of a roof opening is connected (it dies into the roof)', () => {
    dir = mkdtempSync(join(tmpdir(), 'bimdown-geo-'));
    const lv = join(dir, 'lv-1');
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(lv, { recursive: true });
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
    const walls = [line('w-1', [2, 1], [4, 1]), line('w-2', [4, 1], [4, 3]), line('w-3', [2, 3], [2, 1])];
    writeFileSync(join(lv, 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: walls }));
    writeFileSync(join(lv, 'wall.csv'), 'id,thickness\nw-1,0.15\nw-2,0.15\nw-3,0.15\n');
    const ring = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    writeFileSync(join(lv, 'roof.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'ro-1' }, geometry: { type: 'Polygon', coordinates: [ring] } }] }));
    writeFileSync(join(lv, 'roof.csv'), 'id,roof_type,slope\nro-1,gable,30\n');
    const hole = [[2, 1], [4, 1], [4, 3], [3, 4], [2, 3], [2, 1]];
    const op = (host: string) => {
      writeFileSync(join(lv, 'opening.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'op-1' }, geometry: { type: 'Polygon', coordinates: [hole] } }] }));
      writeFileSync(join(lv, 'opening.csv'), `id,host_id\nop-1,${host}\n`);
    };
    op('ro-1');
    expect(validateGeometry(dir).filter(w => w.includes('no connected'))).toEqual([]);
    // Only roof openings count
    op('');
    expect(validateGeometry(dir).filter(w => w.includes('no connected'))).toHaveLength(2);
  });
});
