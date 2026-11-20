/**
 * Issue #14: EditorShell saved every reload of global/level.csv back as if the
 * user had edited the levels. A failed read during a reload after an AI write
 * gave an empty list: the editor wrote a header-only level.csv and deleted
 * level folders. Lists read from disk are now marked and never saved back.
 */
import { describe, it, expect } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import { memoryDataSource, sampleProject } from '../test/memoryDataSource.ts';
import { isLoadedLevels, loadProject } from '../utils/loader.ts';
import { editorReducer, initialState } from './editorReducer.ts';

describe('isLoadedLevels', () => {
  it('marks the list loadProject read, also an empty one', async () => {
    const p = await loadProject(memoryDataSource(sampleProject()));
    expect(p.levels.map(l => l.id)).toEqual(['lv-1', 'lv-2', 'lv-3']);
    expect(isLoadedLevels(p.levels)).toBe(true);
    const empty = await loadProject(memoryDataSource({ ...sampleProject(), 'global/level.csv': 'id,number,name,elevation\n' }));
    expect(empty.levels).toEqual([]);
    expect(isLoadedLevels(empty.levels)).toBe(true);
    expect(isLoadedLevels(undefined)).toBe(false);
  });

  it('SET_PROJECT keeps the loaded list; level edits and their undo are not loaded lists', async () => {
    const project = await loadProject(memoryDataSource(sampleProject()));
    let s = editorReducer(initialState, { type: 'SET_PROJECT', model: 'm', project, grids: [] });
    expect(isLoadedLevels(s.project!.levels)).toBe(true);
    s = editorReducer(s, { type: 'ADD_LEVEL', level: { id: 'lv-4', number: '4', name: 'L4', elevation: 10.8 } });
    expect(isLoadedLevels(s.project!.levels)).toBe(false);
    // Undo back to the disk list is still an edit EditorShell must save
    s = editorReducer(s, { type: 'UNDO' });
    expect(s.project!.levels.map(l => l.id)).toEqual(['lv-1', 'lv-2', 'lv-3']);
    expect(isLoadedLevels(s.project!.levels)).toBe(false);
  });

  it('a harness project (not read from disk) is an editable list', () => {
    const h = createHarness();
    h.dispatch({ type: 'REMOVE_LEVEL', levelId: 'lv-1' });
    expect(isLoadedLevels(h.state.project!.levels)).toBe(false);
  });
});
