import { describe, it, expect } from 'vitest';
import { createHarness, type Harness } from '../test/authorHarness.ts';
import type { CanonicalElement, LineElement, PointElement } from '../model/elements.ts';
import type { EditorState } from './editorTypes.ts';
import { mirrorAcross, rotationAbout, translation, transformElements } from '../model/transform.ts';
import {
  transformPatch, arrayPatch, linearArrayTransforms, radialArrayTransforms, alignDelta, nearestAlignLine, offsetPatch, offsetSide,
} from '../model/modifyOps.ts';
import { createGroupPatch } from '../model/groups.ts';
import { levelElements } from './levelEdits.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import { parseFloorLayers } from '../model/parse.ts';

const els = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);
const byId = (s: EditorState, id: string) => s.document!.elements.get(id)!;
const line = (s: EditorState, id: string) => byId(s, id) as LineElement;
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
  { id: 'lv-3', number: '3', name: 'Level 3', elevation: 6 },
];

/** A 6 × 4 room (walls w-1..w-4 counter-clockwise from the origin) with a door on w-1. */
function room(h: Harness = createHarness(LEVELS)) {
  h.pick('wall');
  for (const [x, y] of [[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('door', { hinge_position: 'start', swing_side: 'left' }); h.click(2, 0); h.done();
  return h;
}

const apply = (h: Harness, r: { patch: Map<string, CanonicalElement | null>; select: string[] }, description = 'op') =>
  h.dispatch({ type: 'APPLY_PATCH', description, patches: r.patch });

describe('rotate', () => {
  it('turns walls, doors and columns about a centre in one undo step', () => {
    const h = room();
    h.pick('column'); h.click(1, 1); h.done();
    const ids = ['w-1', 'w-2', 'w-3', 'w-4', 'c-1'];
    const r = transformPatch(h.state.document!.elements, ids, rotationAbout({ x: 0, y: 0 }, 90), false);
    apply(h, r, 'Rotate');
    expect(near(line(h.state, 'w-1').end, { x: 0, y: 6 })).toBe(true);
    const door = line(h.state, 'd-1');
    // The door rides on its wall, same distance from the wall start
    const expected = resolveHostedGeometry(line(h.state, 'w-1'), parseFloat(door.attrs.position), 0.9);
    expect(near(door.start, expected.start)).toBe(true);
    expect(door.attrs.hinge_position).toBe('start');
    expect(door.attrs.swing_side).toBe('left');
    const col = byId(h.state, 'c-1') as PointElement;
    expect(near(col.position, { x: -1, y: 1 })).toBe(true);
    expect(col.attrs.rotation).toBe('90');
    h.dispatch({ type: 'UNDO' });
    expect(near(line(h.state, 'w-1').end, { x: 6, y: 0 })).toBe(true);
    expect((byId(h.state, 'c-1') as PointElement).position).toEqual({ x: 1, y: 1 });
  });

  it('with copy leaves the original and adds rotated copies with their doors', () => {
    const h = room();
    const r = transformPatch(h.state.document!.elements, ['w-1'], rotationAbout({ x: 0, y: 0 }, 180), true);
    apply(h, r);
    expect(els(h.state, 'wall')).toHaveLength(5);
    expect(els(h.state, 'door')).toHaveLength(2);
    const copy = line(h.state, r.select[0]);
    expect(near(copy.end, { x: -6, y: 0 })).toBe(true);
    const door = els(h.state, 'door').find(d => d.id !== 'd-1') as LineElement;
    expect(door.hostId).toBe(copy.id);
  });

  it('keeps a moved wall joined to the walls it meets', () => {
    const h = room();
    // Rotate the east wall about its bottom end: the north wall's corner follows its top end
    const r = transformPatch(h.state.document!.elements, ['w-2'], rotationAbout({ x: 6, y: 0 }, -10), false);
    apply(h, r);
    expect(near(line(h.state, 'w-3').start, line(h.state, 'w-2').end)).toBe(true);
  });

  it('never moves pinned elements', () => {
    const h = room();
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'w-1', attrs: { pinned: 'true' } });
    const r = transformPatch(h.state.document!.elements, ['w-1', 'w-2'], rotationAbout({ x: 0, y: 0 }, 90), false);
    expect(r.patch.has('w-1')).toBe(false);
    expect(r.patch.has('d-1')).toBe(false);
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['lv-1:w-1'], dx: 1, dy: 1 });
    expect(line(h.state, 'w-1').start).toEqual({ x: 0, y: 0 });
  });
});

describe('mirror', () => {
  it('mirrors a room: walls keep their exterior side, the door hinge and swing follow the mirror image', () => {
    const h = room();
    const before = h.state.document!.elements;
    const T = mirrorAcross({ x: 10, y: 0 }, { x: 0, y: 1 });
    const r = transformPatch(before, ['w-1', 'w-2', 'w-3', 'w-4'], T, true);
    apply(h, r, 'Mirror');
    const map = new Map(r.select.map((nid, i) => [['w-1', 'w-2', 'w-3', 'w-4'][i], nid]));
    const w1 = line(h.state, map.get('w-1')!);
    // w-1 ran (0,0)→(6,0) with the room on its left; the mirror image is
    // reversed, (14,0)→(20,0), so the room is still on its left
    expect(near(w1.start, { x: 14, y: 0 })).toBe(true);
    expect(near(w1.end, { x: 20, y: 0 })).toBe(true);
    const door = els(h.state, 'door').find(d => d.id !== 'd-1') as LineElement;
    const orig = line(h.state, 'd-1');
    // Physical mirror: the hinge end of the copy is the mirror of the original hinge end
    const hingeOrig = orig.attrs.hinge_position === 'end' ? orig.end : orig.start;
    const hingeCopy = door.attrs.hinge_position === 'end' ? door.end : door.start;
    expect(near({ x: 20 - hingeOrig.x, y: hingeOrig.y }, hingeCopy)).toBe(true);
    expect(door.attrs.hinge_position).toBe('end');
    expect(door.attrs.swing_side).toBe('left');
  });

  it('mirroring across the wall itself swings the door to the other side', () => {
    const h = room();
    const T = mirrorAcross({ x: 0, y: 0 }, { x: 1, y: 0 });
    const out = transformElements(h.state.document!.elements, ['w-1', 'd-1'], T);
    // Horizontal axis through w-1: the wall maps onto itself reversed
    expect(near((out.get('w-1') as LineElement).start, { x: 6, y: 0 })).toBe(true);
    const door = out.get('d-1') as LineElement;
    // Hinge stays at x≈1.55, now the door's end; swing 'left' of the reversed wall = −y
    expect(door.attrs.hinge_position).toBe('end');
    expect(door.end.x).toBeCloseTo(1.55, 6);
    expect(door.attrs.swing_side).toBe('left');
  });
});

describe('array', () => {
  it('linear: count with spacing or fit between, one undo step', () => {
    const h = createHarness(LEVELS);
    h.pick('column'); h.click(0, 0); h.done();
    const r = arrayPatch(h.state.document!.elements, ['c-1'], linearArrayTransforms({ x: 3, y: 0 }, 4, false));
    apply(h, r, 'Array');
    expect(els(h.state, 'column').map(c => (c as PointElement).position.x).sort((a, b) => a - b)).toEqual([0, 3, 6, 9]);
    h.dispatch({ type: 'UNDO' });
    expect(els(h.state, 'column')).toHaveLength(1);
    const fit = arrayPatch(h.state.document!.elements, ['c-1'], linearArrayTransforms({ x: 9, y: 0 }, 4, true));
    expect([...fit.patch.values()].map(c => (c as PointElement).position.x)).toEqual([3, 6, 9]);
  });

  it('radial: count over an angle about a centre', () => {
    const h = createHarness(LEVELS);
    h.pick('column'); h.click(5, 0); h.done();
    const r = arrayPatch(h.state.document!.elements, ['c-1'], radialArrayTransforms({ x: 0, y: 0 }, 4, 360));
    const pts = [...r.patch.values()].map(c => (c as PointElement).position);
    expect(near(pts[0], { x: 0, y: 5 })).toBe(true);
    expect(near(pts[1], { x: -5, y: 0 })).toBe(true);
    expect(near(pts[2], { x: 0, y: -5 })).toBe(true);
    expect(radialArrayTransforms({ x: 0, y: 0 }, 3, 90).length).toBe(2);
  });

  it('as a group: every copy is an instance of one model group', () => {
    const h = room();
    const r = arrayPatch(h.state.document!.elements, ['w-1', 'w-2', 'w-3', 'w-4'], linearArrayTransforms({ x: 8, y: 0 }, 3, false), { name: 'Unit' });
    apply(h, r);
    const groups = els(h.state, 'model_group');
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map(g => g.attrs.name))).toEqual(new Set(['Unit']));
    for (const g of groups) {
      const members = [...h.state.document!.elements.values()].filter(e => e.attrs.group_id === g.id);
      expect(members.map(m => m.tableName).sort()).toEqual(['door', 'wall', 'wall', 'wall', 'wall']);
    }
  });
});

describe('align and offset', () => {
  it('align moves a wall face onto a reference line, joined walls follow', () => {
    const h = room();
    const els0 = h.state.document!.elements;
    const ref = { p: { x: 7, y: 0 }, d: { x: 0, y: 1 }, kind: 'center' as const };
    const target = nearestAlignLine(els0.get('w-2')!, { x: 6.09, y: 2 })!;
    expect(target.kind).toBe('face');
    const d = alignDelta(ref, target)!;
    expect(d.x).toBeCloseTo(0.9, 6);
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-2'], dx: d.x, dy: d.y });
    expect(line(h.state, 'w-2').start.x).toBeCloseTo(6.9, 6);
    expect(line(h.state, 'w-1').end.x).toBeCloseTo(6.9, 6);
    // Not parallel: nothing to align
    expect(alignDelta(ref, nearestAlignLine(els0.get('w-1')!, { x: 3, y: 0 })!)).toBeNull();
  });

  it('offset copies a wall to the picked side, or moves it', () => {
    const h = room();
    const els0 = h.state.document!.elements;
    const w1 = els0.get('w-1') as LineElement;
    expect(offsetSide(w1, { x: 3, y: -1 })).toBe(-1);
    const r = offsetPatch(els0, 'w-1', 2, -1, true);
    if (!r || !('patch' in r)) throw new Error('expected a patch');
    const copy = [...r.patch.values()][0] as LineElement;
    expect(copy.start).toEqual({ x: 0, y: -2 });
    const m = offsetPatch(els0, 'w-1', 2, 1, false);
    expect(m && 'move' in m && m.move).toEqual({ x: 0, y: 2 });
  });
});

describe('levels', () => {
  it('copy to levels: walls with their doors land on the chosen levels, one undo step', () => {
    const h = room();
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: ['lv-1:w-1', 'lv-1:w-2'], levelIds: ['lv-2', 'lv-3'] });
    for (const lv of ['lv-2', 'lv-3']) {
      const items = [...levelElements(h.state, lv).values()];
      expect(items.map(e => e.tableName).sort()).toEqual(['door', 'wall', 'wall']);
      const door = items.find(e => e.tableName === 'door')!;
      expect(items.some(e => e.id === door.hostId && e.tableName === 'wall')).toBe(true);
      expect(door.attrs.host_id).toBe(door.hostId);
    }
    const writes = h.state.floorWrites!.writes.map(w => w.levelId).sort();
    expect(writes).toEqual(['lv-2', 'lv-3']);
    h.dispatch({ type: 'UNDO' });
    expect(levelElements(h.state, 'lv-2').size).toBe(0);
    h.dispatch({ type: 'REDO' });
    expect(levelElements(h.state, 'lv-3').size).toBe(3);
  });

  it('a wall copied up keeps its top constraint one storey up', () => {
    const h = room();
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'w-1', attrs: { top_level_id: 'lv-2' } });
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: ['w-1'], levelIds: ['lv-2', 'lv-3'] });
    const top = (lv: string) => [...levelElements(h.state, lv).values()].find(e => e.tableName === 'wall')!.attrs.top_level_id;
    expect(top('lv-2')).toBe('lv-3');
    expect(top('lv-3')).toBe('');
  });

  it('duplicate level copies everything to a new level; undo removes it', () => {
    const h = room();
    h.dispatch({ type: 'DUPLICATE_LEVEL', levelId: 'lv-1', level: { id: 'lv-4', number: '4', name: 'Level 4', elevation: 9 } });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-1', 'lv-2', 'lv-3', 'lv-4']);
    const floor = h.state.project!.floors.get('lv-4')!;
    expect(parseFloorLayers(floor.layers).map(e => e.tableName).sort()).toEqual(['door', 'wall', 'wall', 'wall', 'wall']);
    h.dispatch({ type: 'UNDO' });
    expect(h.state.project!.levels.map(l => l.id)).toEqual(['lv-1', 'lv-2', 'lv-3']);
    expect(h.state.project!.floors.has('lv-4')).toBe(false);
    h.dispatch({ type: 'REDO' });
    expect(levelElements(h.state, 'lv-4').size).toBe(5);
  });

  it('elevation edit: levels above move along; spatial layers of moved levels are rewritten', () => {
    const h = room();
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: ['w-1'], levelIds: ['lv-3'] });
    // a duct on lv-3 (spatial: absolute Z in its GeoJSON)
    const duct: CanonicalElement = {
      geometry: 'spatial_line', id: 'du-1', tableName: 'duct', discipline: 'mep', start: { x: 0, y: 1 }, end: { x: 5, y: 1 },
      startZ: 2.8, endZ: 2.8, strokeWidth: 0.3, attrs: { id: 'du-1', shape: 'rect', size_x: '0.3', size_y: '0.2' },
    };
    h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'duct', patches: new Map([['lv-3', new Map([['du-1', duct]])]]) });
    const seq = h.state.floorWrites!.seq;
    h.dispatch({ type: 'RENAME_LEVEL', levelId: 'lv-2', name: 'Level 2', elevation: 3.5, moveAbove: true });
    expect(h.state.project!.levels.map(l => l.elevation)).toEqual([0, 3.5, 6.5]);
    const writes = h.state.floorWrites!.writes.filter(w => w.seq > seq);
    expect(writes).toEqual([{ seq: seq + 1, levelId: 'lv-3', keys: ['mep/duct'] }]);
    h.dispatch({ type: 'UNDO' });
    expect(h.state.project!.levels.map(l => l.elevation)).toEqual([0, 3, 6]);
    h.dispatch({ type: 'RENAME_LEVEL', levelId: 'lv-2', name: 'L2', elevation: 3.2 });
    expect(h.state.project!.levels.map(l => [l.name, l.elevation])).toEqual([['Level 1', 0], ['L2', 3.2], ['Level 3', 6]]);
  });
});

describe('model groups', () => {
  function groupedRooms() {
    const h = room();
    const els0 = h.state.document!.elements;
    const g = createGroupPatch(els0, ['w-1', 'w-2', 'w-3', 'w-4'], 'Unit', new Set(els0.keys()))!;
    h.dispatch({ type: 'APPLY_PATCH', description: 'Create group', patches: g.patch });
    // Two more instances
    const r = arrayPatch(h.state.document!.elements, [g.groupId], linearArrayTransforms({ x: 10, y: 0 }, 3, false));
    apply(h, r);
    return { h, groupId: g.groupId };
  }

  it('selecting a member selects its whole instance; exact picks one', () => {
    const { h, groupId } = groupedRooms();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-2'] });
    expect([...h.state.selectedIds].sort()).toEqual(['lv-1:d-1', 'lv-1:w-1', 'lv-1:w-2', 'lv-1:w-3', 'lv-1:w-4', `lv-1:${groupId}`].sort());
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-2'], exact: true });
    expect([...h.state.selectedIds]).toEqual(['lv-1:w-2']);
  });

  it('editing one instance updates the others (ids of unchanged members kept), one undo step', () => {
    const { h, groupId } = groupedRooms();
    const other = els(h.state, 'model_group').find(g => g.id !== groupId)!;
    const otherWalls = () => els(h.state, 'wall').filter(w => w.attrs.group_id === other.id) as LineElement[];
    const keptIds = otherWalls().map(w => w.id).sort();
    h.dispatch({ type: 'START_GROUP_EDIT', groupId });
    // Move the east wall 1 m out (corners follow) and add a column inside
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-2'], dx: 1, dy: 0 });
    h.pick('column'); h.click(1, 1); h.done();
    h.dispatch({ type: 'FINISH_GROUP_EDIT' });
    expect(h.state.groupEdit).toBeNull();
    const ox = (other as PointElement).position.x - 3; // other instance origin minus local origin offset
    const walls = otherWalls();
    expect(walls.map(w => w.id).sort()).toEqual(keptIds);
    expect(walls.some(w => Math.abs(w.start.x - (ox + 7)) < 1e-6 && Math.abs(w.end.x - (ox + 7)) < 1e-6)).toBe(true);
    const cols = els(h.state, 'column').filter(c => c.attrs.group_id === other.id) as PointElement[];
    expect(cols).toHaveLength(1);
    expect(near(cols[0].position, { x: ox + 1, y: 1 })).toBe(true);
    h.dispatch({ type: 'UNDO' });
    expect(els(h.state, 'column').filter(c => c.attrs.group_id === other.id)).toHaveLength(0);
  });

  it('an instance on another level follows the edit too', () => {
    const { h, groupId } = groupedRooms();
    const ids = [...h.state.document!.elements.values()].filter(e => e.id === groupId || e.attrs.group_id === groupId).map(e => e.id);
    h.dispatch({ type: 'COPY_TO_LEVELS', ids, levelIds: ['lv-2'] });
    const up = () => [...levelElements(h.state, 'lv-2').values()];
    expect(up().filter(e => e.tableName === 'model_group').map(e => e.attrs.name)).toEqual(['Unit']);
    h.dispatch({ type: 'START_GROUP_EDIT', groupId });
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['d-1'] });
    h.dispatch({ type: 'FINISH_GROUP_EDIT' });
    expect(up().filter(e => e.tableName === 'door')).toHaveLength(0);
    expect(h.state.floorWrites!.writes.at(-1)!.levelId).toBe('lv-2');
    // Every instance on lv-1 lost its door as well
    expect(els(h.state, 'door')).toHaveLength(0);
  });

  it('cancel restores the instance as it was', () => {
    const { h, groupId } = groupedRooms();
    h.dispatch({ type: 'START_GROUP_EDIT', groupId });
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-2'], dx: 2, dy: 0 });
    h.pick('column'); h.click(1, 1); h.done();
    h.dispatch({ type: 'CANCEL_GROUP_EDIT' });
    expect(line(h.state, 'w-2').start.x).toBe(6);
    expect(els(h.state, 'column')).toHaveLength(0);
  });

  it('ungroup and delete keep groups consistent', () => {
    const { h, groupId } = groupedRooms();
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['w-1', 'w-2', 'w-3', 'w-4', 'd-1'] });
    expect(byId(h.state, groupId)).toBeUndefined();
    h.dispatch({ type: 'UNDO' });
    expect(byId(h.state, groupId)).toBeDefined();
  });
});

describe('duplicate', () => {
  it('a copied group becomes a new instance with its own row', () => {
    const h = room();
    const els0 = h.state.document!.elements;
    const g = createGroupPatch(els0, ['w-1', 'w-2', 'w-3', 'w-4'], 'Unit', new Set(els0.keys()))!;
    h.dispatch({ type: 'APPLY_PATCH', description: 'Create group', patches: g.patch });
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1'] });
    h.dispatch({ type: 'DUPLICATE_ELEMENTS', ids: [...h.state.selectedIds], offset: { dx: 10, dy: 0 } });
    const rows = els(h.state, 'model_group');
    expect(rows).toHaveLength(2);
    const copyRow = rows.find(r => r.id !== g.groupId)!;
    expect(els(h.state, 'wall').filter(w => w.attrs.group_id === copyRow.id)).toHaveLength(4);
    expect(translation(0, 0)).toBeTruthy();
  });
});

describe('select all instances in project', () => {
  it('holds the other levels’ instances: delete and change type reach them, in one undo step', async () => {
    const { selectAllInstances } = await import('./selectionOps.ts');
    const h = room();
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: ['lv-1:w-1', 'lv-1:w-2', 'lv-1:d-1'], levelIds: ['lv-2'] });
    const walls = (lv: string) => [...levelElements(h.state, lv).values()].filter(e => e.tableName === 'wall');
    expect(walls('lv-2')).toHaveLength(2);
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1'], exact: true });
    const r = selectAllInstances(h.state, h.dispatch, 'project');
    expect(r).toEqual({ selected: 4, elsewhere: 2 });
    expect(h.state.projectSelection?.get('lv-2')).toHaveLength(2);

    h.dispatch({ type: 'UPDATE_ATTRS_MANY', ids: [...h.state.selectedIds], attrs: { material: 'brick' } });
    expect(walls('lv-2').every(w => w.attrs.material === 'brick')).toBe(true);
    expect(walls('lv-1').every(w => w.attrs.material === 'brick')).toBe(true);

    h.dispatch({ type: 'DELETE_ELEMENTS', ids: [...h.state.selectedIds] });
    expect(walls('lv-1')).toHaveLength(0);
    expect(walls('lv-2')).toHaveLength(0);
    expect([...levelElements(h.state, 'lv-2').values()].some(e => e.tableName === 'door')).toBe(false); // hosted door went with its wall
    h.dispatch({ type: 'UNDO' });
    expect(walls('lv-1')).toHaveLength(4);
    expect(walls('lv-2')).toHaveLength(2);

    // A plain selection change drops the other levels
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1'], exact: true });
    expect(h.state.projectSelection).toBeUndefined();
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['lv-1:w-1'] });
    expect(walls('lv-2')).toHaveLength(2);
  });
});
