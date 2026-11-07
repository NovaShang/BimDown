import { describe, it, expect } from 'vitest';
import { createHarness, type Harness } from '../test/authorHarness.ts';
import type { LineElement } from '../model/elements.ts';
import type { EditorState } from './editorTypes.ts';
import { buildClipboard, parseClipboard, pasteElements, serializeClipboard } from '../model/clipboard.ts';
import { clipboardFromSelection, pasteAligned } from './clipboardCommands.ts';
import { levelElements, takenIds } from './levelEdits.ts';
import { createSequence } from '../tools/shortcuts.ts';
import { selectAllInstances, selectionCategories, filterSelection } from './selectionOps.ts';

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
];

function room(): Harness {
  const h = createHarness(LEVELS);
  h.pick('wall');
  for (const [x, y] of [[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]]) h.click(x, y);
  h.done();
  h.pick('door'); h.click(2, 0); h.done();
  h.pick('window'); h.click(6, 2); h.done();
  h.pick('column'); h.click(1, 1); h.click(5, 1); h.done();
  return h;
}

const tables = (s: EditorState, lv: string) => [...levelElements(s, lv).values()].map(e => e.tableName).sort();

describe('clipboard', () => {
  it('copies the selection with its doors as BimDown JSON', () => {
    const h = room();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1', 'lv-1:w-2'] });
    const p = clipboardFromSelection(h.state)!;
    expect(p.selected).toEqual(['w-1', 'w-2']);
    expect(p.elements.map(e => e.tableName).sort()).toEqual(['door', 'wall', 'wall', 'window']);
    const text = serializeClipboard(p);
    expect(parseClipboard(text)).toEqual(p);
    expect(parseClipboard('hello')).toBeNull();
    expect(parseClipboard('{"bimdown":"other"}')).toBeNull();
  });

  it('pastes at an offset with fresh ids and hosts remapped', () => {
    const h = room();
    const p = buildClipboard(h.state.document!.elements, ['w-1'], { project: 'a', levelId: 'lv-1', levels: LEVELS, units: 'm' })!;
    const { elements, selected } = pasteElements(p, 'lv-1', LEVELS, takenIds(h.state, 'lv-1'), { x: 0, y: -10 });
    const wall = elements.find(e => e.tableName === 'wall') as LineElement;
    const door = elements.find(e => e.tableName === 'door') as LineElement;
    expect(selected).toEqual([wall.id]);
    expect(wall.id).not.toBe('w-1');
    expect(door.hostId).toBe(wall.id);
    expect(wall.start).toEqual({ x: 0, y: -10 });
  });

  it('Paste Aligned to selected levels: one undo step', () => {
    const h = room();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1', 'lv-1:w-2', 'lv-1:w-3', 'lv-1:w-4', 'lv-1:c-1'] });
    const p = clipboardFromSelection(h.state)!;
    expect(pasteAligned(h.state, h.dispatch, p, { levels: ['lv-2'] })).toBeNull();
    expect(tables(h.state, 'lv-2')).toEqual(['column', 'door', 'wall', 'wall', 'wall', 'wall', 'window']);
    // Same place on the source level: a second copy there
    expect(pasteAligned(h.state, h.dispatch, p, 'same')).toBeNull();
    expect(tables(h.state, 'lv-1').filter(t => t === 'wall')).toHaveLength(8);
    h.dispatch({ type: 'UNDO' });
    h.dispatch({ type: 'UNDO' });
    expect(levelElements(h.state, 'lv-2').size).toBe(0);
    expect(tables(h.state, 'lv-1').filter(t => t === 'wall')).toHaveLength(4);
  });

  it('refuses a copy in other units', () => {
    const h = room();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:c-1'] });
    const p = { ...clipboardFromSelection(h.state)!, units: 'ft' as const };
    expect(pasteAligned(h.state, h.dispatch, p, 'current')).toBe('paste.unitsDiffer');
  });
});

describe('selection', () => {
  it('filter by category and select all instances', () => {
    const h = room();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-1', 'lv-1:c-1', 'lv-1:d-1'] });
    expect(selectionCategories(h.state)).toEqual([{ table: 'column', count: 1 }, { table: 'door', count: 1 }, { table: 'wall', count: 1 }]);
    filterSelection(h.state, h.dispatch, new Set(['column']));
    expect([...h.state.selectedIds]).toEqual(['lv-1:c-1']);
    const r = selectAllInstances(h.state, h.dispatch, 'project');
    expect(r.selected).toBe(2);
    expect([...h.state.selectedIds].sort()).toEqual(['lv-1:c-1', 'lv-1:c-2']);
  });

  it('saves named selections for the session', () => {
    const h = room();
    h.dispatch({ type: 'SELECT', ids: ['lv-1:c-1', 'lv-1:c-2'] });
    h.dispatch({ type: 'SAVE_SELECTION_SET', name: 'Columns' });
    expect(h.state.selectionSets).toEqual([{ name: 'Columns', levelId: 'lv-1', ids: ['lv-1:c-1', 'lv-1:c-2'] }]);
    h.dispatch({ type: 'DELETE_SELECTION_SET', name: 'Columns' });
    expect(h.state.selectionSets).toEqual([]);
  });
});

describe('two-letter shortcuts', () => {
  it('fire on the second letter within the window and remember the state before the first', () => {
    const h = room();
    const seq = createSequence();
    expect(seq.onKey('W', h.state, 1000)).toBeNull();
    const hit = seq.onKey('a', h.state, 1500);
    expect(hit?.shortcut.keys).toBe('WA');
    expect(hit?.before.tool).toBe('select');
    // Too slow: no shortcut
    expect(seq.onKey('M', h.state, 2000)).toBeNull();
    expect(seq.onKey('V', h.state, 4000)).toBeNull();
    // MM: the second M completes it
    expect(seq.onKey('M', h.state, 5000)).toBeNull();
    expect(seq.onKey('M', h.state, 5100)?.shortcut.keys).toBe('MM');
    expect(seq.onKey('1', h.state, 5200)).toBeNull();
  });
});
