import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLevel } from './render.js';

const testDir = join(__dirname, 'test-render');

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

describe('renderLevel', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('draws beams as thin dashed centerlines under the walls', () => {
    setup();
    const svg = renderLevel(testDir, 'lv-1');
    const beam = svg.split('\n').find((l) => l.includes('id="bm-1"'))!;
    expect(beam).toContain('stroke-dasharray=');
    expect(Number(/stroke-width="([\d.]+)"/.exec(beam)![1])).toBeLessThan(0.1);
    expect(svg.indexOf('id="bm-1"')).toBeLessThan(svg.indexOf('id="w-1"'));
  });
});
