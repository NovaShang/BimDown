import { describe, it, expect } from 'vitest';
import { editorReducer, initialState } from './editorReducer.ts';
import type { EditorState } from './editorTypes.ts';
import type { LayerData, ProjectData } from '../types.ts';

const layer = (discipline: string, tableName: string): LayerData => ({ discipline, tableName, geojsonContent: '', csvRows: new Map() });

describe('3D all floors after a 2D level switch', () => {
  it("shows every floor's layers, not just the current level's", () => {
    const project = {
      levels: [{ id: 'lv-1', number: '1', name: 'L1', elevation: 0 }, { id: 'lv-2', number: '2', name: 'L2', elevation: 3 }],
      floors: new Map([
        ['lv-1', { levelId: 'lv-1', levelName: 'L1', layers: [layer('architecture', 'wall'), layer('structure', 'foundation')] }],
        ['lv-2', { levelId: 'lv-2', levelName: 'L2', layers: [layer('architecture', 'wall')] }],
      ]),
      globalLayers: [], mepSystems: [],
    } as unknown as ProjectData;
    let s: EditorState = { ...initialState, project, currentLevel: 'lv-1', viewMode: '2d', floor3DMode: 'all' };
    s = editorReducer(s, { type: 'SET_LEVEL', levelId: 'lv-2' });
    expect(s.visibleLayers.has('structure/foundation')).toBe(false); // 2D: this level's layers only
    s = editorReducer(s, { type: 'SET_VIEW_MODE', mode: '3d' });
    expect(s.visibleLayers.has('structure/foundation')).toBe(true);
  });
});
