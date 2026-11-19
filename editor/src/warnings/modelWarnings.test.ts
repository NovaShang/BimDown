import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { levelWarnings, projectWarnings } from './modelWarnings.ts';
import { redundantRooms } from '../annotation/rooms.ts';
import { elementQuantities } from '../schedule/quantities.ts';
import { spaceModule } from '../elements/space.tsx';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { loadProject } from '../utils/loader.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';
import type { CanonicalElement, LineElement, PointElement } from '../model/elements.ts';
import type { Level } from '../types.ts';

const L1: Level = { id: 'lv-1', number: '1', name: 'L1', elevation: 0 };
const L2: Level = { id: 'lv-2', number: '2', name: 'L2', elevation: 3.6 };

const wall = (id: string, a: [number, number], b: [number, number], t = 0.2, attrs: Record<string, string> = {}): LineElement => ({
  id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
  start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, strokeWidth: t, attrs: { thickness: String(t), top_level_id: 'lv-2', ...attrs },
});
const room = (id: string, x: number, y: number, name = ''): PointElement => ({
  id, tableName: 'space', discipline: 'architecture', geometry: 'point', position: { x, y }, width: 0, height: 0, attrs: { name, x: String(x), y: String(y) },
});
const box = (): LineElement[] => [wall('w-1', [0, 0], [10, 0]), wall('w-2', [10, 0], [10, 5]), wall('w-3', [10, 5], [0, 5]), wall('w-4', [0, 5], [0, 0])];
const mapOf = (els: CanonicalElement[]) => new Map(els.map(e => [e.id, e]));

describe('redundant rooms (B2)', () => {
  it('the second seed in one enclosed area is redundant: area 0 in tags, schedules and the plan label', () => {
    const els = [...box(), room('sp-1', 2, 2, 'Lobby'), room('sp-2', 8, 3, 'Stair')];
    expect(redundantRooms(els, box())).toEqual(new Map([['sp-2', 'sp-1']]));
    const q1 = elementQuantities(els[4], L1, [L1, L2], els);
    const q2 = elementQuantities(els[5], L1, [L1, L2], els);
    expect(q1.area).toBeCloseTo(9.8 * 4.8, 6);
    expect(q2.area).toBe(0);
    const ctx = buildGeometryContext({ level: L1, allLevels: [L1, L2], allElements: mapOf(els), unitsPerMetre: 1 });
    expect(spaceModule.geometry(els[5], ctx)).toMatchObject({ area: 0, redundantOf: 'sp-1' });
    expect(spaceModule.geometry(els[4], ctx)!.redundantOf).toBeUndefined();

    const w = levelWarnings(L1, [L1, L2], mapOf(els), 1);
    expect(w.filter(x => x.kind === 'redundant_room')).toEqual([expect.objectContaining({ ids: ['sp-2', 'sp-1'], params: { room: 'Stair', other: 'Lobby' } })]);
  });

  it('a partition gives each room its own area; a seed outside the walls is unbounded', () => {
    const els = [...box(), wall('w-5', [5, 0], [5, 5]), room('sp-1', 2, 2), room('sp-2', 8, 3), room('sp-3', 20, 3)];
    expect(redundantRooms(els, els.filter((e): e is LineElement => e.tableName === 'wall'))).toEqual(new Map());
    const w = levelWarnings(L1, [L1, L2], mapOf(els), 1);
    expect(w.map(x => [x.kind, x.ids])).toEqual([['unbounded_room', ['sp-3']]]);
  });
});

describe('warnings panel checks (G5)', () => {
  it('overlapping doors / windows on one wall, not a window stacked over a door', async () => {
    const files = {
      'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
      'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3.6\n',
      'global/grid.csv': 'id,number,start_x,start_y,end_x,end_y\n',
      'lv-1/wall.csv': 'id,number,thickness,top_level_id\nw-1,,0.2,lv-2\nw-2,,0.1,lv-2\n',
      'lv-1/wall.geojson': fc([
        { type: 'Feature', properties: { id: 'w-1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } },
        { type: 'Feature', properties: { id: 'w-2' }, geometry: { type: 'LineString', coordinates: [[6, 0.04], [9, 0.04]] } },
      ]),
      'lv-1/door.csv': 'id,number,host_id,position,width,height\nd-1,,w-1,2,0.9,2.1\nd-2,,w-1,2.5,0.9,2.1\n',
      'lv-1/window.csv': 'id,number,host_id,position,width,height,base_offset\nwn-1,,w-1,2,0.9,0.5,2.3\n',
      'lv-1/stair.csv': 'id,number,width,step_count,top_level_id\nst-1,,1.2,12,lv-2\n',
      'lv-1/stair.geojson': fc([{ type: 'Feature', properties: { id: 'st-1' }, geometry: { type: 'LineString', coordinates: [[0, 2, 0], [2.4, 2, 3.6]] } }]),
    };
    const project = await loadProject(memoryDataSource(files));
    const w = projectWarnings(project, 1);
    const by = (k: string) => w.filter(x => x.kind === k);
    expect(by('insert_overlap').map(x => x.ids)).toEqual([['d-1', 'd-2']]);
    expect(by('wall_overlap').map(x => x.ids)).toEqual([['w-1', 'w-2']]);
    // 12 risers over 3.6 m = 300 mm riser, 200 mm going: riser, going and 2R+G fail
    expect(by('stair').map(x => x.text)).toEqual(['stair.calc.riserWarn', 'stair.calc.goingWarn', 'stair.calc.blondelWarn']);
    expect(w.every(x => x.levelId === 'lv-1')).toBe(true);
  });
});

describe('pile edge distance', () => {
  it('a pile outside or too close to its cap edge is warned; one well inside is not', () => {
    const cap = {
      id: 'f-1', tableName: 'foundation', discipline: 'structure', geometry: 'polygon',
      vertices: [{ x: 20, y: 24 }, { x: 22.5, y: 24 }, { x: 22.5, y: 26.5 }, { x: 20, y: 26.5 }], attrs: { id: 'f-1', kind: 'pile_cap', thickness: '1' },
    } as CanonicalElement;
    const pile = (id: string, x: number, y: number): PointElement => ({
      id, tableName: 'foundation', discipline: 'structure', geometry: 'point', position: { x, y }, width: 0.6, height: 0.6, attrs: { id, kind: 'pile', width: '0.6' },
    });
    const els = [cap, pile('f-2', 21.25, 25.25), pile('f-3', 20.4, 24.4), pile('f-4', 19.9, 25.25), pile('f-5', 40, 40)];
    const w = levelWarnings(L1, [L1, L2], mapOf(els), 1).filter(x => x.kind === 'pile_edge');
    expect(w.map(x => [x.ids[0], x.text])).toEqual([['f-3', 'warnings.pileEdge'], ['f-4', 'warnings.pileOutside']]);
    expect(w[0].params).toMatchObject({ cap: 'f-1', dist: '0.40', need: '0.60' });
  });
});
