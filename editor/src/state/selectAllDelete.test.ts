import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { deleteConfirmation, DELETE_CONFIRM_THRESHOLD, pendingDeleteStore, requestDelete, selectAllInView } from './selectionOps.ts';
import { getLayerGroups } from './selectors.ts';
import { levelElements } from './levelEdits.ts';
import type { EditorState } from './editorTypes.ts';

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
];

/** Walls, a room and its separator, a structural column and an MEP diffuser on one level. */
function mixed() {
  const h = createHarness(LEVELS);
  h.pick('wall');
  for (const [x, y] of [[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('room_separator'); h.click(3, 0); h.click(3, 4); h.done();
  h.pick('space'); h.click(1.5, 2); h.done();
  h.pick('structure_column'); h.click(1, 1); h.done();
  h.pick('terminal', { __starter_key: 'diffuser_supply' }); h.click(4, 2); h.done();
  const keys = new Set([...h.state.document!.elements.values()].map(e => `${e.discipline}/${e.tableName}`));
  h.dispatch({ type: 'SET_VISIBLE_LAYERS', keys });
  return h;
}

const tables = (s: EditorState, ids: string[]) =>
  new Set(ids.map(id => s.document!.elements.get(id.slice(id.indexOf(':') + 1))!.tableName));

describe('Select All respects the discipline view', () => {
  it('MEP selects only MEP; architecture adds the structure it shows', () => {
    const h = mixed();
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'mep' });
    expect(tables(h.state, selectAllInView(h.state))).toEqual(new Set(['terminal']));

    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    const arch = tables(h.state, selectAllInView(h.state));
    expect(arch.has('wall') && arch.has('space') && arch.has('room_separator')).toBe(true);
    expect(arch.has('structure_column')).toBe(true); // drawn and pickable in the architecture view
    expect(arch.has('terminal')).toBe(false);

    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'structure' });
    expect(tables(h.state, selectAllInView(h.state))).toEqual(new Set(['structure_column']));
  });

  it('skips hidden layers', () => {
    const h = mixed();
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    h.dispatch({ type: 'TOGGLE_LAYER', key: 'architecture/wall' });
    expect(tables(h.state, selectAllInView(h.state)).has('wall')).toBe(false);
  });
});

describe('Delete confirmation', () => {
  it('asks for elements the view does not show, deletes visible ones at once', () => {
    const h = mixed();
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'mep' });
    const terminal = [...h.state.document!.elements.values()].find(e => e.tableName === 'terminal')!;
    expect(deleteConfirmation(h.state, [`lv-1:${terminal.id}`])).toBeNull();
    expect(deleteConfirmation(h.state, ['lv-1:w-1', `lv-1:${terminal.id}`])).toEqual({ count: 2, hidden: 1 });

    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1', `lv-1:${terminal.id}`], exact: true });
    requestDelete(h.state, h.dispatch);
    expect(h.state.document!.elements.has('w-1')).toBe(true); // waiting for the confirmation
    expect(pendingDeleteStore.get()?.hidden).toBe(1);
    pendingDeleteStore.cancel();
    expect(pendingDeleteStore.get()).toBeNull();
    expect(h.state.document!.elements.has('w-1')).toBe(true);

    requestDelete(h.state, h.dispatch);
    pendingDeleteStore.confirm();
    expect(h.state.document!.elements.has('w-1')).toBe(false);
    expect(h.state.document!.elements.has(terminal.id)).toBe(false);
  });

  it(`asks before deleting more than ${DELETE_CONFIRM_THRESHOLD} visible elements`, () => {
    const h = createHarness(LEVELS);
    h.pick('column');
    for (let i = 0; i <= DELETE_CONFIRM_THRESHOLD; i++) h.click(i, 0);
    h.done();
    h.dispatch({ type: 'SET_VISIBLE_LAYERS', keys: new Set(['architecture/column']) });
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    const ids = selectAllInView(h.state);
    expect(ids).toHaveLength(DELETE_CONFIRM_THRESHOLD + 1);
    expect(deleteConfirmation(h.state, ids)).toEqual({ count: DELETE_CONFIRM_THRESHOLD + 1, hidden: 0 });
    expect(deleteConfirmation(h.state, ids.slice(1))).toBeNull();
  });

  it('the layer count of a table emptied by Delete drops to 0', () => {
    const h = mixed();
    // As loaded from disk: the floor carries the rows the panel counted before
    const s0 = h.state;
    const floorRows = new Map([...s0.document!.elements.values()].filter(e => e.tableName === 'wall').map(e => [e.id, e.attrs]));
    h.dispatch({
      type: 'SET_PROJECT', model: 'test', grids: [],
      project: { ...s0.project!, floors: new Map([['lv-1', { layers: [{ tableName: 'wall', discipline: 'architecture', geojsonContent: '', csvRows: floorRows }] }]]) } as never,
    });
    h.dispatch({ type: 'INIT_DOCUMENT', document: s0.document! });
    const count = () => getLayerGroups(h.state).find(g => g.discipline === 'architecture')!.layers.find(l => l.tableName === 'wall')?.csvRows.size;
    expect(count()).toBe(4);
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['w-1', 'w-2', 'w-3', 'w-4'] });
    expect(count()).toBe(0);
  });
});

describe('Copy to levels outside the architecture view', () => {
  it('leaves rooms and room separators behind', () => {
    const h = mixed();
    const all = [...h.state.document!.elements.keys()].map(id => `lv-1:${id}`);
    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'mep' });
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: all, levelIds: ['lv-2'] });
    const copied = new Set([...levelElements(h.state, 'lv-2').values()].map(e => e.tableName));
    expect(copied.has('space') || copied.has('room_separator')).toBe(false);
    expect(copied.has('terminal')).toBe(true);
    h.dispatch({ type: 'UNDO' });

    h.dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    h.dispatch({ type: 'COPY_TO_LEVELS', ids: all, levelIds: ['lv-2'] });
    const arch = new Set([...levelElements(h.state, 'lv-2').values()].map(e => e.tableName));
    expect(arch.has('space') && arch.has('room_separator')).toBe(true);
  });
});
