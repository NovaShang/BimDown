import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { duplicateNumbers } from './modelWarnings.ts';
import { loadProject } from '../utils/loader.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import { curtainDoors, curtainGrid, remapDoorNumbers, setPanelKinds } from '../elements/curtainWallLayout.ts';
import { assignNumbers } from '../model/autoNumber.ts';
import { scheduleRows, SCHEDULES } from '../schedule/schedules.ts';
import type { CanonicalElement } from '../model/elements.ts';

const ln = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

function files() {
  return {
    'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm', project_name: 'T' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\n',
    'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
    'lv-1/wall.csv': 'id,number,thickness,top_level_id\nw-1,,0.2,lv-2\n',
    'lv-1/wall.geojson': fc([ln('w-1', [0, 0], [10, 0])]),
    'lv-1/door.csv': 'id,number,host_id,position,width,height\nd-1,D101,w-1,2,0.9,2.1\n',
    'lv-1/window.csv': 'id,number,host_id,position,width,height,base_offset\nwn-1,W101,w-1,5,0.9,1.2,0.9\n',
    'lv-1/curtain_wall.csv': 'id,number,top_level_id,v_grid_count,u_grid_count,panels,door_numbers\ncw-1,,lv-2,3,2,1:0=door,D101\n',
    'lv-1/curtain_wall.geojson': fc([ln('cw-1', [0, 5], [6, 5])]),
    'lv-2/wall.csv': 'id,number,thickness,top_level_id\nw-1,,0.2,\n',
    'lv-2/wall.geojson': fc([ln('w-1', [0, 0], [10, 0])]),
    'lv-2/window.csv': 'id,number,host_id,position,width,height,base_offset\nwn-1,W101,w-1,5,0.9,1.2,0.9\n',
  };
}

describe('unique numbers (N1, N5)', () => {
  it('warns on a number used twice across levels and on curtain wall door panels', async () => {
    const project = await loadProject(memoryDataSource(files()));
    const w = duplicateNumbers(project);
    expect(w.map(x => [x.params.number, x.params.count, x.ids])).toEqual([
      ['D101', 2, ['d-1', 'cw-1']],
      ['W101', 2, ['wn-1']],
    ]);
    expect(w[1].params.levels).toBe('L1, L2');
  });

  it('door panels keep their marks per cell; new door panels take the next door number', () => {
    const g0 = curtainGrid({ v_grid_count: '3', u_grid_count: '2', panels: '1:0=door' }, 6, 3);
    let n = 104;
    const next = () => `D${++n}`;
    const g1 = curtainGrid({ v_grid_count: '3', u_grid_count: '2', ...setPanelKinds(g0, [{ col: 2, row: 0 }], 'double_door') }, 6, 3);
    expect(remapDoorNumbers(g0, g1, 'D102', next)).toBe('D102;D105');
    const g2 = curtainGrid({ v_grid_count: '3', u_grid_count: '2', panels: '2:0=double_door' }, 6, 3);
    expect(remapDoorNumbers(g1, g2, 'D102;D105', next)).toBe('D105');
    expect(curtainDoors(g1, 'D102;D105').map(d => [d.col, d.kind, d.number])).toEqual([[1, 'door', 'D102'], [2, 'double_door', 'D105']]);
  });

  it('auto-numbered doors skip marks held by curtain wall door panels', () => {
    const cw = { id: 'cw-1', tableName: 'curtain_wall', attrs: { door_numbers: 'D101;D102' } } as unknown as CanonicalElement;
    const d = { id: 'd-9', tableName: 'door', attrs: {} } as unknown as CanonicalElement;
    expect(assignNumbers([d], [cw], { level: { id: 'lv-1', number: '1', name: 'L1', elevation: 0 } }).get('d-9')).toBe('D103');
  });

  it('the door schedule lists curtain wall door panels with their marks', async () => {
    const project = await loadProject(memoryDataSource(files()));
    const doors = SCHEDULES.find(c => c.key === 'doors')!;
    const rows = scheduleRows(doors, project, 'm', t => t, undefined, undefined, 'en');
    const cw = rows.filter(r => r.table === 'curtain_wall');
    expect(cw).toHaveLength(1);
    expect(cw[0].values).toMatchObject({ number: 'D101', width: 2, count: 1 });
    expect(cw[0].values.height).toBeCloseTo(1.5, 6);
  });
});
