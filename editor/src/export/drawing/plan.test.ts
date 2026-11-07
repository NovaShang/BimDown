import { describe, it, expect } from 'vitest';
import '../../elements/registerAll.ts';
import { loadProject, loadGrids } from '../../utils/loader.ts';
import { memoryDataSource, fc } from '../../test/memoryDataSource.ts';
import { buildPlanDrawing, chainEdges, formatArea } from './plan.ts';
import { registerPlanAnnotator } from './annotations.ts';
import { LAYERS } from './layers.ts';
import { buildPlanDxfFiles, planToDxf } from '../exportDxf.ts';
import { dxfLineweight } from './dxfWriter.ts';
import type { DrawItem } from './types.ts';

/** A 4 × 3 room (scaled by `k` model units per metre) with a door, a window, a stair, a duct and two grids. */
function room(k = 1, units = 'm') {
  const s = (v: number) => v * k;
  const line = (id: string, a: number[], b: number[]) =>
    ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a.map(s), b.map(s)] } });
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units, spatial_z: 'absolute', project_name: 'Test' }),
    'global/level.csv': `id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,${s(3)}\n`,
    'global/grid.csv': `id,number,start_x,start_y,end_x,end_y\ngr-1,1,0,${s(-2)},0,${s(5)}\ngr-2,A,${s(-2)},0,${s(6)},0\n`,
    'lv-1/wall.csv': `id,number,thickness,material\n${['w-1', 'w-2', 'w-3', 'w-4'].map(id => `${id},,${s(0.2)},brick`).join('\n')}\n`,
    'lv-1/wall.geojson': fc([
      line('w-1', [0, 0], [4, 0]), line('w-2', [4, 0], [4, 3]), line('w-3', [4, 3], [0, 3]), line('w-4', [0, 3], [0, 0]),
    ]),
    'lv-1/door.csv': `id,number,host_id,position,width,height,operation,hinge_position,swing_side\nd-1,,w-1,${s(1)},${s(0.9)},${s(2.1)},single_swing,start,left\n`,
    'lv-1/window.csv': `id,number,host_id,position,width,height,base_offset\nwn-1,,w-3,${s(2)},${s(1.2)},${s(1.5)},${s(0.9)}\n`,
    'lv-1/space.csv': `id,number,name,x,y\nsp-1,101,客厅,${s(2)},${s(1.5)}\n`,
    'lv-1/stair.csv': `id,number,width,step_count\nst-1,,${s(1)},10\n`,
    'lv-1/stair.geojson': fc([line('st-1', [3, 0.5, 0], [3, 2.5, 3])]),
    'lv-1/duct.csv': `id,number,shape,size_x,size_y,system_type\ndu-1,,rect,${s(0.4)},${s(0.3)},SA\n`,
    'lv-1/duct.geojson': fc([line('du-1', [0.5, 2, 2.7], [3.5, 2, 2.7])]),
    'lv-2/wall.csv': `id,number,thickness\nw-5,,${s(0.2)}\n`,
    'lv-2/wall.geojson': fc([line('w-5', [0, 0], [4, 0])]),
  } as Record<string, string>;
}

async function open(files: Record<string, string>) {
  const ds = memoryDataSource(files);
  return { project: await loadProject(ds), grids: await loadGrids(ds) };
}

const on = (items: DrawItem[], layer: string) => items.filter(i => i.layer === layer);

describe('plan drawing', () => {
  it('draws cut walls with poché, a door swing, window lines, a room tag with area and grid bubbles', async () => {
    const { project, grids } = await open(room());
    const d = buildPlanDrawing({ project, levelId: 'lv-1', grids, discipline: 'architecture' }, 100)!;
    expect(d.pm).toBeCloseTo(0.1, 9); // 1 mm on paper = 0.1 m at 1:100
    const poche = on(d.items, 'A-WALL-PATT');
    expect(poche.length).toBeGreaterThanOrEqual(5); // 4 walls, two of them split by openings
    expect(poche.every(i => i.kind === 'path' && i.fill && i.noStroke)).toBe(true);
    expect(on(d.items, 'A-WALL').length).toBeGreaterThan(0);

    const arcs = on(d.items, 'A-DOOR-SWNG').filter(i => i.kind === 'arc');
    expect(arcs).toHaveLength(1);
    const arc = arcs[0] as Extract<DrawItem, { kind: 'arc' }>;
    expect(arc.radius).toBeCloseTo(0.9, 6);
    // Hinge on the wall face at the door's start (x = 1 − 0.45), swing to the left (+y side)
    expect(arc.center.x).toBeCloseTo(0.55, 6);
    expect(arc.center.y).toBeCloseTo(0.1, 6);
    expect(on(d.items, 'A-GLAZ').length).toBe(3); // frame + two glazing lines

    const texts = d.items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text);
    expect(texts).toEqual(expect.arrayContaining(['客厅', '101', '10.64 m²', '1', 'A']));
    expect(on(d.items, 'S-GRID-IDEN').filter(i => i.kind === 'circle')).toHaveLength(4); // both ends of 2 grids

    // Architecture sheets leave MEP out; an MEP sheet fades the building and lists the systems
    expect(d.items.some(i => i.layer.startsWith('M-DUCT'))).toBe(false);
    const mep = buildPlanDrawing({ project, levelId: 'lv-1', grids, discipline: 'mep' }, 100)!;
    expect(mep.items.some(i => i.layer === 'M-DUCT-SA')).toBe(true);
    expect(on(mep.items, 'A-WALL').every(i => i.halftone)).toBe(true);
    expect(mep.legend.map(l => l.label)).toEqual(['SA']);
  });

  it('cuts stairs at the plan height: lower treads solid, upper ones hidden, with UP', async () => {
    const { project } = await open(room());
    const d = buildPlanDrawing({ project, levelId: 'lv-1', discipline: 'architecture' }, 100)!;
    // 3 m rise over 10 steps: cut at 1.2 m → treads 1..4 below, 5..9 above
    const below = on(d.items, 'A-FLOR-STRS').filter(i => i.kind === 'path' && i.pts.length === 2);
    const above = on(d.items, 'A-FLOR-STRS-ABOV');
    expect(above.length).toBeGreaterThanOrEqual(5);
    expect(below.length).toBeGreaterThanOrEqual(4);
    expect(d.items.some(i => i.kind === 'text' && i.text === 'UP')).toBe(true);
  });

  it('runs annotators (the hook for dimensions) and writes their items', async () => {
    const { project } = await open(room());
    const off = registerPlanAnnotator(ctx => {
      ctx.add({ kind: 'text', layer: ctx.layer(LAYERS.annoDims), at: { x: 2, y: -1 }, text: '4000', height: 2.5 * ctx.pm, align: 'center', valign: 'baseline' });
    });
    try {
      const d = buildPlanDrawing({ project, levelId: 'lv-1' }, 100)!;
      expect(on(d.items, 'G-ANNO-DIMS')).toHaveLength(1);
      expect(planToDxf(d)).toContain('\nG-ANNO-DIMS\n');
    } finally { off(); }
    expect(on(buildPlanDrawing({ project, levelId: 'lv-1' }, 100)!.items, 'G-ANNO-DIMS')).toHaveLength(0);
  });

  it('chains wall outline edges into polylines', () => {
    const p = (x: number, y: number) => ({ x, y });
    expect(chainEdges([[p(0, 0), p(1, 0)], [p(1, 0), p(1, 1)], [p(5, 5), p(6, 5)]], 1e-9)).toEqual([
      [p(0, 0), p(1, 0), p(1, 1)], [p(5, 5), p(6, 5)],
    ]);
  });

  it('formats room areas per project unit', () => {
    expect(formatArea(12.345, 'm')).toBe('12.35 m²');
    expect(formatArea(12_345_000, 'mm')).toBe('12.35 m²');
    expect(formatArea(100, 'ft')).toBe('100.0 ft²');
  });
});

describe('DXF plans', () => {
  it('writes one file per level in model coordinates (Y up), metres', async () => {
    const { project, grids } = await open(room());
    const files = buildPlanDxfFiles(project, 'test', { scope: 'all', grids });
    expect(files.map(f => f[0])).toEqual(['test-L1.dxf', 'test-L2.dxf']);
    const dxf = files[0][1];
    expect(dxf).toContain('$INSUNITS\n70\n6');
    expect(dxf).toContain('$ACADVER\n1\nAC1021');
    // The top wall's outer face is at y = 3.1, not mirrored to −3.1
    expect(dxf).toMatch(/\n20\n3\.1\n/);
    expect(dxf).not.toMatch(/\n20\n-3\.1\n/);
    for (const name of ['A-WALL', 'A-WALL-PATT', 'A-DOOR', 'A-DOOR-SWNG', 'A-GLAZ', 'A-AREA-IDEN', 'S-GRID', 'S-GRID-IDEN']) {
      expect(dxf).toContain(`\nLAYER\n5\n`);
      expect(dxf, name).toContain(`\n2\n${name}\n`);
    }
    expect(dxf).toContain('\nHATCH\n');
    expect(dxf).toContain('\nARC\n');
    expect(dxf).toContain('\n1\n客厅\n');
    // Handles are unique
    const handles = [...dxf.matchAll(/\n(?:5|105)\n([0-9A-F]+)\n/g)].map(m => m[1]);
    expect(new Set(handles).size).toBe(handles.length);
    // Current level only
    expect(buildPlanDxfFiles(project, 'test', { scope: 'current', levelId: 'lv-2', grids }).map(f => f[0])).toEqual(['test-L2.dxf']);
  });

  it('uses millimetres for an mm project, with text sized for the plot scale', async () => {
    const { project, grids } = await open(room(1000, 'mm'));
    const d = buildPlanDrawing({ project, levelId: 'lv-1', grids, discipline: 'architecture' }, 100)!;
    expect(d.pm).toBeCloseTo(100, 6); // 1 mm on paper = 100 mm at 1:100
    const tag = d.items.find(i => i.kind === 'text' && i.text === '10.64 m²');
    expect(tag).toBeDefined();
    const dxf = buildPlanDxfFiles(project, 'mm', { scope: 'current', levelId: 'lv-1', grids })[0][1];
    expect(dxf).toContain('$INSUNITS\n70\n4');
    expect(dxf).toMatch(/\n20\n3100\.0\n/);
  });

  it('snaps lineweights to AutoCAD values', () => {
    expect(dxfLineweight(0.5)).toBe(50);
    expect(dxfLineweight(0.18)).toBe(18);
    expect(dxfLineweight(0.09)).toBe(9);
    expect(dxfLineweight(0.33)).toBe(35);
  });
});
