import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import en from '../i18n/en.json';
import { createHarness } from '../test/authorHarness.ts';
import { finishPolygon } from '../tools/drawPolygonTool.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import { removeLevelFiles, restoreLevelFiles } from '../utils/persist.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import type { LineElement, PointElement, PolygonElement, SpatialLineElement } from '../model/elements.ts';
import { materialiseRoute } from '../utils/orthoRoute.ts';
import { systemFitsTable } from '../model/mepTopology.ts';
import type { EditorState } from './editorTypes.ts';

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});

const els = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);
const byId = (s: EditorState, id: string) => s.document!.elements.get(id)!;

function houseWithDoor() {
  const h = createHarness([
    { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
    { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3.6 },
  ]);
  h.pick('wall');
  for (const [x, y] of [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('door'); h.click(3, 0); h.done();
  return h;
}

describe('B3 rooms placed in a row', () => {
  it('get their own number and name', () => {
    const h = createHarness();
    h.pick('space'); h.click(1, 1); h.click(3, 1); h.click(5, 1); h.done();
    expect(els(h.state, 'space').map(e => [e.attrs.number, e.attrs.name])).toEqual([
      ['1', 'Room 1'], ['2', 'Room 2'], ['3', 'Room 3'],
    ]);
  });

  it('continue after the highest existing number', () => {
    const h = createHarness();
    h.pick('space', { number: '101' }); h.click(1, 1); h.done();
    h.pick('space'); h.click(3, 1); h.done();
    expect(els(h.state, 'space').map(e => e.attrs.number)).toEqual(['101', '102']);
  });
});

describe('B5 roof default height', () => {
  it('sits on top of the walls', () => {
    const h = houseWithDoor();
    h.pick('roof');
    expect(h.state.drawingAttrs.base_offset).toBe('3.6'); // walls run up to Level 2
  });

  it('without walls: one storey up, or the next level', () => {
    const one = createHarness();
    one.pick('roof');
    expect(one.state.drawingAttrs.base_offset).toBe('3');
    const two = createHarness([
      { id: 'lv-1', number: '1', name: 'L1', elevation: 0 },
      { id: 'lv-2', number: '2', name: 'L2', elevation: 4.2 },
    ]);
    two.pick('roof');
    expect(two.state.drawingAttrs.base_offset).toBe('4.2');
  });
});

describe('B10 level add / remove / rename are undoable', () => {
  it('removing the open level can be undone and redone', () => {
    const h = houseWithDoor();
    h.dispatch({ type: 'REMOVE_LEVEL', levelId: 'lv-1' });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-2']);
    expect(h.state.currentLevel).toBe('lv-2');
    expect(h.state.document).toBeNull();
    // EditorShell opens the next level's document; level commands survive it
    h.dispatch({ type: 'INIT_DOCUMENT', document: { levelId: 'lv-2', elements: new Map() } });
    h.dispatch({ type: 'UNDO' });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-1', 'lv-2']);
    expect(h.state.currentLevel).toBe('lv-1');
    const floor = h.state.project!.floors.get('lv-1')!;
    expect(floor.layers.find(l => l.tableName === 'wall')!.csvRows.size).toBe(4);
    expect(floor.layers.find(l => l.tableName === 'door')!.csvRows.size).toBe(1);
    h.dispatch({ type: 'REDO' });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-2']);
  });

  it('add and rename undo', () => {
    const h = createHarness();
    h.dispatch({ type: 'ADD_LEVEL', level: { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 } });
    h.dispatch({ type: 'RENAME_LEVEL', levelId: 'lv-2', name: 'Roof', elevation: 3.2 });
    expect(h.state.project!.levels[1]).toMatchObject({ name: 'Roof', elevation: 3.2 });
    h.dispatch({ type: 'UNDO' });
    expect(h.state.project!.levels[1]).toMatchObject({ name: 'Level 2', elevation: 3 });
    h.dispatch({ type: 'UNDO' });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-1']);
    expect(h.state.currentLevel).toBe('lv-1');
  });

  it("the level's files are deleted and can be written back", async () => {
    const ds = memoryDataSource({ 'lv-1/wall.csv': 'id\nw-1\n', 'lv-1/wall.geojson': '{}', 'lv-10/wall.csv': 'id\nw-9\n', 'global/level.csv': 'x' });
    const snap = await removeLevelFiles(ds, 'lv-1');
    expect(Object.keys(ds.files).sort()).toEqual(['global/level.csv', 'lv-10/wall.csv']);
    await restoreLevelFiles(ds, snap);
    expect(ds.files['lv-1/wall.csv']).toBe('id\nw-1\n');
  });
});

describe('B11 duplicate', () => {
  it('a wall brings its door along, hosted on the copy', () => {
    const h = houseWithDoor();
    h.dispatch({ type: 'DUPLICATE_ELEMENTS', ids: ['w-1'], offset: { dx: 0, dy: -5 } });
    const doors = els(h.state, 'door');
    expect(doors).toHaveLength(2);
    const copy = doors.find(d => d.id !== 'd-1') as LineElement;
    const newWall = [...h.state.selectedIds][0].split(':').pop()!;
    expect(newWall).not.toBe('w-1');
    expect(copy.hostId).toBe(newWall);
    expect(copy.attrs.host_id).toBe(newWall);
    expect(copy.start.y).toBeCloseTo(-5, 6);
  });

  it('a door alone stays on its wall, next to the original, with position and geometry in sync', () => {
    const h = houseWithDoor();
    h.dispatch({ type: 'DUPLICATE_ELEMENTS', ids: ['d-1'], offset: { dx: 0.5, dy: 0.5 } });
    const copy = els(h.state, 'door').find(d => d.id !== 'd-1') as LineElement;
    expect(copy.hostId).toBe('w-1');
    const pos = parseFloat(copy.attrs.position);
    expect(pos).toBeCloseTo(3 + 0.9 + 0.1, 3);
    const expected = resolveHostedGeometry(byId(h.state, 'w-1') as LineElement, pos, 0.9);
    expect(copy.start).toEqual(expected.start);
    expect(copy.end).toEqual(expected.end);
  });
});

describe('B12 multi-selection edit', () => {
  it('sets a value on every element as one undo step', () => {
    const h = houseWithDoor();
    h.dispatch({ type: 'UPDATE_ATTRS_MANY', ids: ['lv-1:w-1', 'lv-1:w-2', 'lv-1:w-3'], attrs: { thickness: '0.3' } });
    expect(['w-1', 'w-2', 'w-3', 'w-4'].map(id => byId(h.state, id).attrs.thickness)).toEqual(['0.3', '0.3', '0.3', '0.2']);
    expect((byId(h.state, 'w-2') as LineElement).strokeWidth).toBe(0.3);
    expect(h.state.lastMutation!.keys).toEqual(['architecture/wall']);
    h.dispatch({ type: 'UNDO' });
    expect(['w-1', 'w-2', 'w-3'].map(id => byId(h.state, id).attrs.thickness)).toEqual(['0.2', '0.2', '0.2']);
  });

  it('typing a value (several edits of the same field) is still one undo step', () => {
    const h = houseWithDoor();
    const ids = ['lv-1:w-1', 'lv-1:w-2'];
    for (const v of ['0', '0.3', '0.35']) h.dispatch({ type: 'UPDATE_ATTRS_MANY', ids, attrs: { thickness: v } });
    expect(byId(h.state, 'w-2').attrs.thickness).toBe('0.35');
    h.dispatch({ type: 'UNDO' });
    expect(['w-1', 'w-2'].map(id => byId(h.state, id).attrs.thickness)).toEqual(['0.2', '0.2']);
    expect(els(h.state, 'door')).toHaveLength(1); // the door placed before is not undone
  });
});

describe('B14 closing a polygon', () => {
  it('right-click / Enter closes with 3+ vertices', () => {
    const h = createHarness();
    h.pick('slab');
    h.click(0, 0);
    h.click(4, 0);
    expect(finishPolygon(h.state, h.dispatch)).toBe(false);
    h.click(4, 3);
    expect(finishPolygon(h.state, h.dispatch)).toBe(true);
    const slab = els(h.state, 'slab')[0] as PolygonElement;
    expect(slab.vertices).toHaveLength(3);
    expect(h.state.drawingState?.points).toEqual([]);
  });
});

describe('MEP B4 templates', () => {
  it('use the toolbar Base Offset; a single-system terminal joins that system', () => {
    const h = createHarness();
    h.pick('terminal', { [STARTER_KEY_ATTR]: 'diffuser_supply', base_offset: '1.3' });
    h.click(2, 2);
    const tm = els(h.state, 'terminal')[0] as PointElement;
    expect(tm.attrs.base_offset).toBe('1.3');
    expect(tm.attrs.system_type).toBe('SA');
    h.pick('equipment', { [STARTER_KEY_ATTR]: 'ahu_chw_2pipe', base_offset: '1' });
    h.click(6, 2);
    const eq = els(h.state, 'equipment')[0] as PointElement;
    expect(eq.attrs.base_offset).toBe('1');
    expect(eq.attrs.system_type ?? '').toBe(''); // several systems: left to the user
  });
});

describe('MEP B5-B7 endpoint joining in 3D', () => {
  const pipe = (h: ReturnType<typeof createHarness>, a: [number, number], b: [number, number], z0: string, z1: string, extra: Record<string, string> = {}) => {
    h.pick('pipe', { start_z: z0, end_z: z1, system_type: 'DCW', ...extra });
    h.click(...a); h.click(...b); h.done();
  };
  const nodes = (s: EditorState) => els(s, 'mep_node') as PointElement[];

  it('a fitting node gets the pipe height, not the level', () => {
    const h = createHarness();
    pipe(h, [0, 0], [4, 0], '5.8', '5.8');
    pipe(h, [4, 0], [4, 3], '5.8', '5.8');
    expect(nodes(h.state).map(n => n.attrs.base_offset)).toEqual(['5.8']);
  });

  it('ends at the same plan point but different heights do not join; a riser never joins itself', () => {
    const h = createHarness();
    pipe(h, [0, 0], [4, 0], '0.5', '0.5');
    pipe(h, [4, 0], [4, 3], '3', '3');
    expect(nodes(h.state)).toHaveLength(0);
    h.pick('pipe', { start_z: '-4', end_z: '0.5', system_type: 'DCW', __vertical_mode: 'true' });
    h.click(0, 0); h.done();
    const riser = els(h.state, 'pipe').find(p => (p as LineElement).start.x === (p as LineElement).end.x && (p as LineElement).start.y === (p as LineElement).end.y)!;
    expect(riser.attrs.from).not.toBe(riser.attrs.to || undefined);
    expect(riser.attrs.from ?? '').toBe('');
  });

  it('a branch into a sloped pipe keeps the slope on both halves', () => {
    const h = createHarness();
    pipe(h, [0, 0], [10, 0], '0.5', '0.4');
    pipe(h, [5, 3], [5, 0], '0.45', '0.45');
    const pipes = els(h.state, 'pipe') as unknown as { id: string; startZ: number; endZ: number }[];
    const up = pipes.find(p => p.id === 'pi-1')!;
    const down = pipes.find(p => p.id !== 'pi-1' && p.id !== 'pi-2')!;
    expect(up.startZ).toBeCloseTo(0.5, 6);
    expect(up.endZ).toBeCloseTo(0.45, 6);
    expect(down.startZ).toBeCloseTo(0.45, 6);
    expect(down.endZ).toBeCloseTo(0.4, 6);
    expect(nodes(h.state)[0].attrs.base_offset).toBe('0.45');
  });
});

describe('MEP B3 line width after reload', () => {
  it('comes from size_x, and follows edits', async () => {
    const { parseLayer } = await import('../model/parse.ts');
    const [duct] = parseLayer({
      tableName: 'duct', discipline: 'mep', csvRows: new Map([['du-1', { id: 'du-1', shape: 'rect', size_x: '0.6', size_y: '0.35' }]]),
      geojsonContent: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 3], [5, 0, 3]] } }] }),
    }) as LineElement[];
    expect(duct.strokeWidth).toBe(0.6);
    const h = createHarness();
    h.pick('duct', { size_x: '0.4', start_z: '3', end_z: '3' }); h.click(0, 0); h.click(5, 0); h.done();
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'du-1', attrs: { size_x: '0.8' } });
    expect((byId(h.state, 'du-1') as LineElement).strokeWidth).toBe(0.8);
  });
});

describe('MEP B8 a route from a port ends at the target height', () => {
  it('adds a vertical segment when the target sits higher or lower', () => {
    const out = materialiseRoute([{ x: 0, y: 0 }, { x: 3, y: 0 }], {
      tableName: 'duct', discipline: 'mep', z: 4.5, endZ: 5.8, fromRef: 'tm-1:in', toRef: 'mn-9',
      systemType: 'SA', shape: 'rect', sizeX: '0.3', sizeY: '0.2', levelId: 'lv-1',
    }, new Set());
    const ducts = out.filter(e => e.tableName === 'duct') as SpatialLineElement[];
    expect(ducts.map(d => [d.startZ, d.endZ])).toEqual([[4.5, 4.5], [4.5, 5.8]]);
    expect(ducts[1].attrs.to).toBe('mn-9');
    expect((out.find(e => e.tableName === 'mep_node') as PointElement).attrs.base_offset).toBe('4.5');
  });
});

describe('MEP B9 system dropdowns', () => {
  it('offer air systems on ducts and water systems on pipes, whatever the discipline', () => {
    const chw = { system_type: 'CHWS', name: 'Chilled water supply', discipline: 'hvac' };
    const sa = { system_type: 'SA', name: 'Supply air', discipline: 'hvac' };
    const fp = { system_type: 'FP', name: 'Sprinkler', discipline: 'fire' };
    const pwr = { system_type: 'PWR', name: 'Power', discipline: 'electrical' };
    const fits = (table: string) => [chw, sa, fp, pwr].filter(s => systemFitsTable(s, table)).map(s => s.system_type);
    expect(fits('pipe')).toEqual(['CHWS', 'FP']);
    expect(fits('duct')).toEqual(['SA']);
    expect(fits('cable_tray')).toEqual(['PWR']);
    // An HVAC system with an unknown code is offered on both
    expect(systemFitsTable({ system_type: 'X1', discipline: 'hvac' }, 'duct')).toBe(true);
    expect(systemFitsTable({ system_type: 'X1', discipline: 'hvac' }, 'pipe')).toBe(true);
  });
});

