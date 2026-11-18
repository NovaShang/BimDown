import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './index.js';
import { renderLevel } from '../render.js';
import { parseSlopeArrow, slopeRiseAt } from '../geo/slab-slope.js';

const testDir = join(__dirname, 'test-slab-slope');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const poly = (id: string, ring: number[][]) =>
  ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });

function project(csv: string) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(join(testDir, 'lv-1'), { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: 2, units: 'm' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  writeFileSync(join(testDir, 'lv-1', 'slab.csv'), csv);
  writeFileSync(join(testDir, 'lv-1', 'slab.geojson'), fc([poly('sl-1', [[0, 0], [10, 0], [10, 4], [0, 4]])]));
}

describe('slab slope arrow', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('parses the arrow and its plane', () => {
    const a = parseSlopeArrow('0,2,0;10,2,0.5');
    expect(typeof a).toBe('object');
    if (!a || typeof a === 'string') return;
    expect(slopeRiseAt(a, 5, -7)).toBeCloseTo(0.25, 9);
    expect(parseSlopeArrow('1,1,0;1,1,1')).toMatch(/different/);
    expect(parseSlopeArrow('1,1;2,2,2')).toMatch(/tx,ty,tz/);
    expect(parseSlopeArrow('')).toBeNull();
  });

  it('accepts a sloped slab and renders its arrow', () => {
    project('id,thickness,slope_arrow\nsl-1,0.2,"0,2,0;10,2,0.5"\n');
    const r = validate(testDir);
    expect(r.filter(i => i.includes('slab'))).toEqual([]);
    expect(renderLevel(testDir, 'lv-1')).toContain('class="slope-arrow"');
  });

  it('reports a malformed slope arrow', () => {
    project('id,thickness,slope_arrow\nsl-1,0.2,"0,2,0;0,2,1"\n');
    const r = validate(testDir);
    expect(r.some(i => i.includes('slope_arrow') && i.includes('different'))).toBe(true);
  });
});
