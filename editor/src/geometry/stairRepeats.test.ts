import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { stairsRepeatingOn } from './stairRepeats.ts';
import { buildPlanDrawing } from '../export/drawing/plan.ts';

const files = (multistory: string) => ({
  'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', spatial_z: 'absolute' }),
  'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-3,3,L3,6.5\nlv-4,4,Roof,9.5\n',
  'lv-1/stair.csv': `id,number,width,step_count,stair_type,top_level_id,multistory_top_level_id\nst-1,S1,1.0,9,quarter_turn,lv-2,${multistory}\n`,
  'lv-1/stair.geojson': fc([{ type: 'Feature', properties: { id: 'st-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 0], [3.5, 0, 1.5]] } }]),
  'lv-1/stair_run.csv': 'id,number,host_id,width,step_count\nsr-1,,st-1,1.0,9\n',
  'lv-1/stair_run.geojson': fc([{ type: 'Feature', properties: { id: 'sr-1' }, geometry: { type: 'LineString', coordinates: [[4, 0.5, 1.5], [4, 4, 3]] } }]),
  'lv-1/stair_landing.csv': 'id,number,base_offset,host_id,thickness\nsl_land-1,,1.5,st-1,0.2\n',
  'lv-1/stair_landing.geojson': fc([{ type: 'Feature', properties: { id: 'sl_land-1' }, geometry: { type: 'Polygon', coordinates: [[[3.5, -0.5], [4.5, -0.5], [4.5, 0.5], [3.5, 0.5], [3.5, -0.5]]] } }]),
  'lv-1/railing.csv': 'id,number,host_id,side,height\nrl-1,,st-1,left,\n',
  'lv-2/wall.csv': 'id,number,thickness\nw-1,,0.2\n',
  'lv-2/wall.geojson': fc([{ type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[-2, -2], [-2, 6]] } }]),
});

describe('multi-storey stairs on upper storeys', () => {
  it('lists the stair, its parts and railings on every storey it repeats on, not above', async () => {
    const project = await loadProject(memoryDataSource(files('lv-3')));
    const on2 = stairsRepeatingOn(project, 'lv-2');
    expect(on2).toHaveLength(1);
    expect(on2[0].level.id).toBe('lv-1');
    expect(on2[0].elements.map(e => e.id).sort()).toEqual(['rl-1', 'sl_land-1', 'sr-1', 'st-1']);
    expect(stairsRepeatingOn(project, 'lv-3')).toEqual([]); // the top level is where it arrives
    expect(stairsRepeatingOn(project, 'lv-1')).toEqual([]); // its own level draws it anyway
    const single = await loadProject(memoryDataSource(files('')));
    expect(stairsRepeatingOn(single, 'lv-2')).toEqual([]);
  });

  it('plan sheets of an upper storey draw the repeated stair (also on a level without its own files)', async () => {
    const project = await loadProject(memoryDataSource(files('lv-4')));
    for (const lv of ['lv-2', 'lv-3']) {
      const d = buildPlanDrawing({ project, levelId: lv, discipline: 'architecture' }, 100)!;
      expect(d.items.some(i => i.layer.startsWith('A-FLOR-STRS')), lv).toBe(true);
    }
  });
});

describe('modify on stairs', () => {
  it('copies and mirrors take runs, landings and stair railings along; a mirror swaps railing sides', async () => {
    const { expandCopySet } = await import('../model/copySet.ts');
    const { transformPatch } = await import('../model/modifyOps.ts');
    const { mirrorAcross } = await import('../model/transform.ts');
    const { parseFloorLayers } = await import('../model/parse.ts');
    const project = await loadProject(memoryDataSource(files('')));
    const els = new Map(parseFloorLayers(project.floors.get('lv-1')!.layers).map(e => [e.id, e]));
    expect([...expandCopySet(els, ['st-1'])].sort()).toEqual(['rl-1', 'sl_land-1', 'sr-1', 'st-1']);
    const r = transformPatch(els, ['st-1'], mirrorAcross({ x: 10, y: 0 }, { x: 0, y: 1 }), true);
    const copies = [...r.patch.values()].filter(e => !!e);
    expect(copies.map(e => e!.tableName).sort()).toEqual(['railing', 'stair', 'stair_landing', 'stair_run']);
    const stair = copies.find(e => e!.tableName === 'stair')!;
    for (const c of copies) if (c!.tableName !== 'stair') expect(c!.attrs.host_id || c!.hostId).toBe(stair.id);
    expect(copies.find(e => e!.tableName === 'railing')!.attrs.side).toBe('right');
  });
});
