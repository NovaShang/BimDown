import { describe, it, expect } from 'vitest';
import { load } from '../test/annotationFixture.ts';
import { rootReducer, unsavedMutationKeys } from './EditorContext.tsx';

describe('autosave sees every mutation', () => {
  it('two edits dispatched before the save effect runs are both pending', async () => {
    let { state } = await load();
    const before = state.lastMutation?.version ?? 0;
    // One event, two dispatches (e.g. a tool that edits a wall and its door)
    state = rootReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:w-1', attrs: { material: 'brick' } });
    state = rootReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:d-1', attrs: { material: 'wood' } });
    const first = unsavedMutationKeys(state, before);
    expect([...first.keys].sort()).toEqual(['architecture/door', 'architecture/wall']);
    // Only what came after the last save is pending next time
    state = rootReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:sp-1', attrs: { name: 'Hall' } });
    expect([...unsavedMutationKeys(state, first.version).keys]).toEqual(['architecture/space']);
  });

  it('a new document starts a new log', async () => {
    let { state } = await load();
    state = rootReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:w-1', attrs: { material: 'brick' } });
    state = rootReducer(state, { type: 'INIT_DOCUMENT', document: state.document! });
    expect(unsavedMutationKeys(state, 0).keys.size).toBe(0);
  });
});
