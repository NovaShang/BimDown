import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './validate/index.js';
import { build } from './build/index.js';
import { renderLevel } from './render.js';
import {
  dimensionGeometry, formatDimension, indexLevelElements, resolveDimensionPoint, tagLines,
} from './annotations.js';

const testDir = join(__dirname, 'test-annotations');
const lv = join(testDir, 'lv-1');

const line = (id: string, a: number[], b: number[]) => ({
  type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] },
});

/** 10 × 5 box (walls 0.2 thick) with one door, one room. */
function setup(eastWallX = 10) {
  mkdirSync(join(testDir, 'global'), { recursive: true });
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }));
  writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
  const walls = [
    line('w-1', [0, 0], [eastWallX, 0]), line('w-2', [eastWallX, 0], [eastWallX, 5]),
    line('w-3', [eastWallX, 5], [0, 5]), line('w-4', [0, 5], [0, 0]),
  ];
  writeFileSync(join(lv, 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: walls }));
  writeFileSync(join(lv, 'wall.csv'), 'id,number,thickness,material\n' + walls.map((w) => `${w.properties.id},,0.2,concrete`).join('\n') + '\n');
  writeFileSync(join(lv, 'door.csv'), 'id,number,host_id,position,width,height,operation\nd-1,D01,w-1,2,0.9,2.1,single_swing\n');
  writeFileSync(join(lv, 'space.csv'), 'id,number,x,y,name\nsp-1,101,5,2.5,Office\n');
}

const writeDims = (rows: string[]) =>
  writeFileSync(join(lv, 'dimension.csv'), ['id,start_x,start_y,end_x,end_y,start_ref,end_ref,direction,offset,text', ...rows].join('\n') + '\n');

describe('annotation tables', () => {
  beforeEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it('validates clean dimension / text / tag tables', () => {
    setup();
    writeDims(['dm-1,0,2.5,10,2.5,w-4,w-2,0,-1,', 'dm-2,0,0,2,0,w-1:start,d-1:center,,-0.8,']);
    writeFileSync(join(lv, 'text_note.csv'), 'id,x,y,text,size,rotation\ntx-1,5,6,North wing,0.3,0\n');
    writeFileSync(join(lv, 'tag.csv'), 'id,host_id,x,y,content\ntg-1,sp-1,,,auto\ntg-2,d-1,2,-1,number\n');
    expect(validate(testDir)).toEqual([]);
  });

  it('reports bad references, anchors, coincident points and half-pinned tags', () => {
    setup();
    writeDims(['dm-1,0,0,1,0,w-9,,,0,', 'dm-2,0,0,1,0,w-1:middle,,,0,', 'dm-3,1,1,1,1,,,,0,', 'dm-4,a,0,1,0,,,,0,']);
    writeFileSync(join(lv, 'tag.csv'), 'id,host_id,x,y,content\ntg-1,d-1,3,,auto\n');
    const issues = validate(testDir);
    expect(issues.some((i) => i.includes('dimension.csv:2') && i.includes('non-existent'))).toBe(true);
    expect(issues.some((i) => i.includes('dimension.csv:3') && i.includes('unknown anchor'))).toBe(true);
    expect(issues.some((i) => i.includes('dimension.csv:4') && i.includes('coincide'))).toBe(true);
    expect(issues.some((i) => i.includes('dimension.csv:5') && i.includes('not a number'))).toBe(true);
    expect(issues.some((i) => i.includes('tag.csv:2') && i.includes('both x and y'))).toBe(true);
  });

  it('rejects annotations in global/', () => {
    setup();
    writeFileSync(join(testDir, 'global', 'text_note.csv'), 'id,x,y,text\ntx-1,0,0,hi\n');
    expect(validate(testDir).some((i) => i.startsWith('global/text_note.csv') && i.includes('level directory'))).toBe(true);
  });

  it('resolves references: projection on location lines, faces, ends, opening edges', () => {
    setup();
    const index = indexLevelElements(lv, join(testDir, 'global'));
    expect(resolveDimensionPoint('w-2', { x: 9, y: 3 }, index)).toEqual({ x: 10, y: 3 });
    // w-2 runs north: its left face is to the west
    expect(resolveDimensionPoint('w-2:left', { x: 9, y: 3 }, index).x).toBeCloseTo(9.9);
    expect(resolveDimensionPoint('w-1:end', { x: 0, y: 0 }, index)).toEqual({ x: 10, y: 0 });
    expect(resolveDimensionPoint('d-1:start', { x: 0, y: 0 }, index).x).toBeCloseTo(1.55);
    expect(resolveDimensionPoint('', { x: 4, y: 4 }, index)).toEqual({ x: 4, y: 4 });
    expect(resolveDimensionPoint('w-404', { x: 4, y: 4 }, index)).toEqual({ x: 4, y: 4 });
  });

  it('measures along the direction and offsets the dimension line', () => {
    const g = dimensionGeometry({ x: 0, y: 0 }, { x: 3, y: 1 }, 0, -1)!;
    expect(g.value).toBeCloseTo(3);
    expect(g.d1).toEqual({ x: 0, y: -1 });
    expect(g.d2.x).toBeCloseTo(3);
    expect(g.d2.y).toBeCloseTo(-1);
    expect(dimensionGeometry({ x: 0, y: 0 }, { x: 3, y: 4 }, null, 0)!.value).toBeCloseTo(5);
    expect(formatDimension(3.6, 'm')).toBe('3600');
    expect(formatDimension(12.5, 'ft')).toBe(`12'-6"`);
  });

  it('dimension follows a moved wall in the render', () => {
    setup(10);
    writeDims(['dm-1,0,2.5,10,2.5,w-4,w-2,0,-1,']);
    expect(renderLevel(testDir, 'lv-1')).toContain('>10000<');
    // Move the east wall to x=12 without touching the stored dimension points
    setup(12);
    writeDims(['dm-1,0,2.5,10,2.5,w-4,w-2,0,-1,']);
    expect(renderLevel(testDir, 'lv-1')).toContain('>12000<');
  });

  it('room tags show name, number and the build area', () => {
    setup();
    writeFileSync(join(lv, 'tag.csv'), 'id,host_id,x,y,content\ntg-1,sp-1,,,auto\ntg-2,d-1,,,auto\n');
    expect(build(testDir).issues).toEqual([]);
    const index = indexLevelElements(lv, join(testDir, 'global'));
    expect(tagLines(index.get('sp-1')!, 'auto', 'm')).toEqual(['Office', '101', '50.00 m²']);
    expect(tagLines(index.get('d-1')!, 'size', 'm')).toEqual(['900×2100']);
    const svg = renderLevel(testDir, 'lv-1');
    expect(svg).toContain('data-annotation="tag"');
    expect(svg).toContain('>50.00 m²<');
    expect(svg).toContain('>D01<');
  });
});
