import { describe, it, expect } from 'vitest';
import '../../elements/registerAll.ts';
import { loadProject, loadGrids } from '../../utils/loader.ts';
import { memoryDataSource, fc } from '../../test/memoryDataSource.ts';
import { buildViewDrawing, collectViewSource, renderView, resolveViewId, VIEW_LAYERS } from './section.ts';
import { itemsBounds } from './plan.ts';
import { planToDxf } from '../exportDxf.ts';
import type { DrawItem } from './types.ts';

/**
 * A 6 × 4 room on two storeys: 0.2 walls (3 m), a door in the south wall, a
 * window in the north wall, a 0.2 slab on top, grids 1 / 2 across it and a
 * section "A" cutting west → east at y = 2 (looking north).
 */
function building() {
  const line = (id: string, a: number[], b: number[]) =>
    ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
  const poly = (id: string, ring: number[][]) =>
    ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute', project_name: 'Test' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,Ground,0\nlv-2,2,First,3.2\n',
    'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\ngr-1,1,0,-2,0,6\ngr-2,2,6,-2,6,6\n',
    'global/view.csv': 'id,name,view_type,start_x,start_y,end_x,end_y,depth\nvw-1,A,section,-1,2,7,2,\n',
    'global/dimension.csv': 'id,start_x,start_y,end_x,end_y,start_ref,end_ref,direction,offset,text,view_id\ndm-1,0,0,0,3.2,,,90,-1,,vw-1\n',
    'global/text_note.csv': 'id,x,y,text,size,paper_size,rotation,view_id\ntx-1,3,4,Roof,,3.5,0,vw-1\n',
    'lv-1/wall.csv': `id,number,thickness,material,top_level_id\n${['w-1', 'w-2', 'w-3', 'w-4'].map(id => `${id},,0.2,brick,lv-2`).join('\n')}\n`,
    'lv-1/wall.geojson': fc([line('w-1', [0, 0], [6, 0]), line('w-2', [6, 0], [6, 4]), line('w-3', [6, 4], [0, 4]), line('w-4', [0, 4], [0, 0])]),
    'lv-1/door.csv': 'id,number,host_id,position,width,height,operation\nd-1,,w-1,2,1,2.1,single_swing\n',
    'lv-1/window.csv': 'id,number,host_id,position,width,height,base_offset\nwn-1,,w-3,3,1.5,1.2,0.9\n',
    'lv-2/slab.csv': 'id,number,thickness,base_offset\nsl-1,,0.2,0\n',
    'lv-2/slab.geojson': fc([poly('sl-1', [[-0.1, -0.1], [6.1, -0.1], [6.1, 4.1], [-0.1, 4.1]])]),
  } as Record<string, string>;
}

async function open(files: Record<string, string>) {
  const ds = memoryDataSource(files);
  return { project: await loadProject(ds), grids: await loadGrids(ds) };
}

const on = (items: DrawItem[], layer: string) => items.filter(i => i.layer === layer);
const paths = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { kind: 'path' }> => i.kind === 'path');

describe('section and elevation drawings', () => {
  it('cuts the side walls and the slab as poché, draws the back wall with its window beyond', async () => {
    const { project, grids } = await open(building());
    const d = buildViewDrawing({ project, grids }, { kind: 'section', id: 'vw-1' }, 100)!;
    expect(d.kind).toBe('section');
    expect(d.title).toBe('Section A');
    // Poché: two wall cuts (x ≈ -0.1…0.1 and 5.9…6.1, z 0…3.2) and the slab (top at level 2: z 3.0…3.2)
    const poche = paths(on(d.items, 'A-SECT-PATT'));
    const boxes = poche.map(p => itemsBounds([p])!);
    const wallCuts = boxes.filter(b => b.maxX - b.minX < 0.25 && b.maxY - b.minY > 3);
    expect(wallCuts.length).toBe(2);
    expect(wallCuts.some(b => Math.abs(b.minX + 0.1) < 1e-3 && Math.abs(b.maxX - 0.1) < 1e-3)).toBe(true);
    expect(boxes.some(b => b.maxX - b.minX > 6 && Math.abs(b.minY - 3.0) < 1e-3 && Math.abs(b.maxY - 3.2) < 1e-3)).toBe(true);
    // Cut outlines on the heavy pen layer
    expect(on(d.items, 'A-SECT-MCUT').length).toBeGreaterThanOrEqual(3);
    // Beyond: the north wall's window opening (x 2.25…3.75, z 0.9…2.1) appears as lines
    const beyond = paths(on(d.items, 'A-SECT-MBND'));
    const has = (x0: number, y0: number, x1: number, y1: number) => beyond.some(p => {
      const [a, b] = p.pts;
      const m = (u: number, v: number, x: number, y: number) => Math.abs(u - x) < 1e-3 && Math.abs(v - y) < 1e-3;
      return (m(a.x, a.y, x0, y0) && m(b.x, b.y, x1, y1)) || (m(a.x, a.y, x1, y1) && m(b.x, b.y, x0, y0));
    });
    expect(has(2.25, 0.9, 3.75, 0.9)).toBe(true); // sill
    expect(has(2.25, 0.9, 2.25, 2.1)).toBe(true); // jamb
    // Nothing beyond is drawn through the cut walls: no beyond line inside x ∈ (-0.09, 0.09)
    expect(beyond.every(p => !p.pts.every(q => q.x > -0.09 && q.x < 0.09 && q.y > 0.05 && q.y < 3.1))).toBe(true);
    // The door (south wall) is behind the cut plane: not drawn
    expect(beyond.some(p => p.pts.every(q => Math.abs(q.x - 1.5) < 1e-3 || Math.abs(q.x - 2.5) < 1e-3) && p.pts.some(q => Math.abs(q.y - 2.1) < 1e-3))).toBe(false);
  });

  it('draws levels with heads, grid bubbles and the view’s own annotations at paper size', async () => {
    const { project, grids } = await open(building());
    const src = collectViewSource({ project, grids });
    const d100 = renderView(src, { kind: 'section', id: 'vw-1' }, 100)!;
    const texts = d100.items.filter((i): i is Extract<DrawItem, { kind: 'text' }> => i.kind === 'text');
    expect(texts.map(t => t.text)).toEqual(expect.arrayContaining(['Ground', 'First', '±0.000', '+3.200', '1', '2', 'Roof', '3200']));
    expect(on(d100.items, VIEW_LAYERS.level.name).length).toBe(2);
    expect(d100.items.some(i => i.kind === 'circle' && i.layer === 'S-GRID-IDEN')).toBe(true);
    // Paper-sized: the 3.5 mm note is twice as tall in the model at 1:200
    const d200 = renderView(src, { kind: 'section', id: 'vw-1' }, 200)!;
    const note = (d: typeof d100) => d.items.find((i): i is Extract<DrawItem, { kind: 'text' }> => i.kind === 'text' && i.text === 'Roof')!;
    expect(note(d200).height / note(d100).height).toBeCloseTo(2, 6);
    expect(note(d100).height).toBeCloseTo(0.35 * 0.72, 6);
  });

  it('elevations show the whole façade with no poché, and resolve view ids', async () => {
    const { project, grids } = await open(building());
    const d = buildViewDrawing({ project, grids }, { kind: 'elevation', id: 'south' }, 100)!;
    expect(on(d.items, 'A-SECT-PATT')).toHaveLength(0);
    const lines = paths(on(d.items, 'A-ELEV-OTLN'));
    // The door opening in the south façade (x 1.5…2.5 seen from the south, up to 2.1)
    const xs = lines.flatMap(p => p.pts.map(q => q.x));
    expect(xs.some(x => Math.abs(x - 1.5) < 1e-3)).toBe(true);
    expect(xs.some(x => Math.abs(x - 2.5) < 1e-3)).toBe(true);
    expect(resolveViewId('south', project.sections ?? [])).toEqual({ kind: 'elevation', id: 'south' });
    expect(resolveViewId('vw-1', project.sections ?? [])).toEqual({ kind: 'section', id: 'vw-1' });
    expect(resolveViewId('vw-9', project.sections ?? [])).toBeNull();
    // View annotations stay out of the plans' global layers
    expect(project.globalLayers.some(l => l.tableName === 'dimension')).toBe(false);
    expect(project.viewAnnotations?.map(l => l.tableName).sort()).toEqual(['dimension', 'text_note']);
  });

  it('writes a valid DXF for a section', async () => {
    const { project, grids } = await open(building());
    const d = buildViewDrawing({ project, grids }, { kind: 'section', id: 'vw-1' }, 100)!;
    const dxf = planToDxf(d);
    expect(dxf).toContain('A-SECT-MCUT');
    expect(dxf).toContain('HATCH');
    expect(dxf.trim().endsWith('EOF')).toBe(true);
  });
});
