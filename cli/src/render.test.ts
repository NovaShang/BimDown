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

  it('draws grids, foundations, slab holes, openings and real column sizes', () => {
    const lv = setup();
    const fcOf = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
    const pt = (id: string, c: number[], props: Record<string, unknown> = {}) =>
      ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Point', coordinates: c } });
    writeFileSync(join(testDir, 'global', 'grid.csv'), 'id,number,start_x,start_y,end_x,end_y\ngr-1,A,0,-2,0,7\n');
    writeFileSync(join(lv, 'structure_column.csv'), 'id,number,shape,size_x,size_y\nsc-1,,rect,0.6,0.4\nsc-2,,round,0.8,\n');
    writeFileSync(join(lv, 'structure_column.geojson'), fcOf([pt('sc-1', [0, 0]), pt('sc-2', [10, 0])]));
    writeFileSync(join(lv, 'foundation.csv'), 'id,number,kind,thickness,width,length\nf-1,,,0.6,2,2.4\nf-2,,pile,18,0.8,\nf-3,,,0.5,1.2,\n');
    writeFileSync(join(lv, 'foundation.geojson'), fcOf([
      pt('f-1', [0, 0]), pt('f-2', [10, 0]),
      line('f-3', [0, 5], [10, 5]),
    ]));
    writeFileSync(join(lv, 'structure_slab.csv'), 'id,number,thickness\nss-1,,0.2\n');
    writeFileSync(join(lv, 'structure_slab.geojson'), fcOf([{ type: 'Feature', properties: { id: 'ss-1' }, geometry: { type: 'Polygon', coordinates: [
      [[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]], [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]] } }]));
    const svg = renderLevel(testDir, 'lv-1');
    const lineOf = (id: string) => svg.split('\n').find((l) => l.includes(`id="${id}"`))!;
    expect(lineOf('gr-1')).toContain('stroke-dasharray');
    expect(svg).toContain('>A</text>');
    // 0.6 × 0.4 rect column, 0.8 round column (not a 0.3 dot)
    expect(lineOf('sc-1')).toContain('points="-0.3,-0.2 0.3,-0.2 0.3,0.2 -0.3,0.2"');
    expect(lineOf('sc-2')).toContain('r="0.4"');
    // Pad 2 × 2.4, pile circle Ø0.8, strip 1.2 wide — all dashed
    expect(lineOf('f-1')).toContain('points="-1,-1.2 1,-1.2 1,1.2 -1,1.2"');
    expect(lineOf('f-2')).toContain('r="0.4"');
    expect(lineOf('f-3')).toContain('0,5.6');
    for (const id of ['f-1', 'f-2', 'f-3']) expect(lineOf(id)).toContain('stroke-dasharray');
    // Slab hole kept as a second sub-path
    expect(lineOf('ss-1').match(/M /g)).toHaveLength(2);
    expect(svg.indexOf('id="f-1"')).toBeLessThan(svg.indexOf('id="ss-1"'));
  });

  it('draws steel and hollow sections at their outline and the slab span arrow', () => {
    const lv = setup();
    const fcOf = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
    const pt = (id: string, c: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: c } });
    writeFileSync(join(testDir, 'global', 'column_type.csv'), 'id,name,description,material,shape,size_x,size_y,flange,web,thickness,root_radius,designation,material_grade\n'
      + 'colt-1,CHS 219.1x8,,steel,round_hollow,0.2191,,,,0.008,,CHS 219.1x8,S355\n');
    writeFileSync(join(lv, 'structure_column.csv'), 'id,number,shape,size_x,size_y,flange,web,thickness,type_id\n'
      + 'sc-1,,i_shape,0.3,0.29,0.014,0.0085,,\nsc-2,,rect_hollow,0.2,0.2,,,0.01,\nsc-3,,,,,,,,colt-1\n');
    writeFileSync(join(lv, 'structure_column.geojson'), fcOf([pt('sc-1', [0, 0]), pt('sc-2', [5, 0]), pt('sc-3', [10, 0])]));
    writeFileSync(join(lv, 'structure_slab.csv'), 'id,number,thickness,span_direction\nss-1,,0.2,90\n');
    writeFileSync(join(lv, 'structure_slab.geojson'), fcOf([{ type: 'Feature', properties: { id: 'ss-1' }, geometry: { type: 'Polygon', coordinates: [
      [[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]] } }]));
    const svg = renderLevel(testDir, 'lv-1');
    const lineOf = (id: string) => svg.split('\n').find((l) => l.includes(`id="${id}"`))!;
    // I: 12-point outline; RHS and CHS (typed): outer + inner ring, even-odd
    expect(lineOf('sc-1').match(/ L /g)).toHaveLength(11);
    expect(lineOf('sc-2').match(/M /g)).toHaveLength(2);
    expect(lineOf('sc-2')).toContain('fill-rule="evenodd"');
    expect(lineOf('sc-3').match(/M /g)).toHaveLength(2);
    expect(lineOf('sc-3')).toContain('M 10.11,0');
    // Span arrow along +Y through the centroid (5, 2.5)
    const span = lineOf('ss-1-span');
    expect(span).toContain('M 5,1.5 L 5,3.5');
  });

  it('blanks the host wall under an embedded curtain wall', () => {
    const lv = setup();
    writeFileSync(join(lv, 'curtain_wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [line('cw-1', [3, 0.05], [7, 0.05]), line('cw-2', [3, 2], [7, 2])] }));
    writeFileSync(join(lv, 'curtain_wall.csv'), 'id,number\ncw-1,\ncw-2,\n');
    const svg = renderLevel(testDir, 'lv-1');
    const masks = svg.split('\n').filter((l) => l.includes('stroke="white"') && l.includes('<line'));
    expect(masks).toHaveLength(1);
    expect(masks[0]).toContain('x1="3"');
    expect(masks[0]).toContain('x2="7"');
    expect(svg.indexOf(masks[0])).toBeLessThan(svg.indexOf('id="cw-1"'));
    expect(svg.indexOf(masks[0])).toBeGreaterThan(svg.indexOf('id="w-1"'));
  });

  it('blanks an arc wall along an embedded arc curtain wall', () => {
    const lv = setup();
    const arc = { radius: 5, large_arc: false, sweep: true };
    const d = (deg: number) => [10 + 5 * Math.cos(deg * Math.PI / 180), 10 + 5 * Math.sin(deg * Math.PI / 180)];
    writeFileSync(join(lv, 'wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'w-9', arc }, geometry: { type: 'LineString', coordinates: [d(0), d(180)] } }] }));
    writeFileSync(join(lv, 'wall.csv'), 'id,number,thickness,material\nw-9,,0.2,concrete\n');
    writeFileSync(join(lv, 'curtain_wall.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'cw-9', arc }, geometry: { type: 'LineString', coordinates: [d(45), d(135)] } }] }));
    writeFileSync(join(lv, 'curtain_wall.csv'), 'id,number\ncw-9,\n');
    const svg = renderLevel(testDir, 'lv-1');
    const masks = svg.split('\n').filter((l) => l.includes('stroke="white"') && l.includes('<polyline'));
    expect(masks).toHaveLength(1);
    // From 45° to 135° over the top of the arc
    expect(masks[0]).toContain('points="13.536,13.536 ');
    expect(masks[0]).toContain(' 6.464,13.536"');
    expect(masks[0]).toContain(' 10.074,14.999 ');
  });
});
