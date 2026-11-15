import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, LineElement } from './elements.ts';
import type { GridData, Level, ProjectData } from '../types.ts';
import { beamSystemSegments, bayDirection } from './beamSystem.ts';
import { beamSystemIn } from '../tools/drawRegionTool.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import { createDocument } from './document.ts';
import type { EditorState } from '../state/editorTypes.ts';
import type { ToolStateSnapshot } from '../tools/types.ts';
import { parseTypeFiles } from './types/catalog.ts';
import { serializeToCsv } from './serialize.ts';

const levels: Level[] = [{ id: 'lv-1', number: '1', name: 'L1', elevation: 0 }, { id: 'lv-2', number: '2', name: 'L2', elevation: 4 }];
const grids: GridData[] = [
  { id: 'gr-1', number: '1', x1: 0, y1: -2, x2: 0, y2: 10 }, { id: 'gr-2', number: '2', x1: 8.4, y1: -2, x2: 8.4, y2: 10 },
  { id: 'gr-3', number: 'A', x1: -2, y1: 0, x2: 10, y2: 0 }, { id: 'gr-4', number: 'B', x1: -2, y1: 7.2, x2: 10, y2: 7.2 },
];
const types = { types: parseTypeFiles({ 'global/beam_type.csv': 'id,name,description,material,shape,size_x,size_y\nbmt-1,Steel 250x450,,steel,rect,0.25,0.45\nbmt-2,Steel 300x600,,steel,rect,0.3,0.6\n' }), saved: true };
const project = { levels, floors: new Map(), globalLayers: [], mepSystems: [], metadata: { format_version: '3.0' }, types } as unknown as ProjectData;

const beamsOf = (s: EditorState, sys = 'bs-1') => [...s.document!.elements.values()].filter(e => e.tableName === 'beam' && e.attrs.beam_system_id === sys) as LineElement[];

describe('associative beam systems', () => {
  it('lays out evenly spaced lines along a direction, clipped to the bay', () => {
    const bay = [{ x: 0, y: 0 }, { x: 8.4, y: 0 }, { x: 8.4, y: 7.2 }, { x: 0, y: 7.2 }];
    expect(bayDirection(bay, 'short')).toBe(90); // the 7.2 side
    const segs = beamSystemSegments(bay, 2, 90);
    expect(segs.map(([a]) => a.x).sort((a, b) => a - b)).toEqual([1.68, 3.36, 5.04, 6.72]);
    expect(Math.min(segs[0][0].y, segs[0][1].y)).toBeCloseTo(0, 9);
    expect(Math.max(segs[0][0].y, segs[0][1].y)).toBeCloseTo(7.2, 9);
    // An L-shaped bay clips lines into pieces
    const L = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 }];
    expect(beamSystemSegments(L, 1.5, 0).length).toBe(3);
  });

  it('places a system + its beams; spacing / type / bay edits regenerate them in one undo step', () => {
    let state = { ...initialState, project, grids, currentLevel: 'lv-1', document: createDocument('lv-1', []) } as EditorState;
    const snap = {
      document: state.document, project, grids,
      drawingTarget: { tableName: 'beam', discipline: 'structure', variantId: 'beam_system' },
      drawingAttrs: { shape: 'rect', size_x: '0.25', size_y: '0.45', material: 'steel', type_id: 'bmt-1', __spacing: '2', __span: 'short' },
    } as unknown as ToolStateSnapshot;
    const els = beamSystemIn(snap, { x: 4, y: 3 }, { x: 4, y: 3 }, true);
    expect(els[0].tableName).toBe('beam_system');
    state = editorReducer(state, { type: 'CREATE_ELEMENTS', elements: els, description: 'Place beam system', selectPrimary: false });
    expect(beamsOf(state)).toHaveLength(4);
    expect(beamsOf(state).every(b => b.attrs.number === 'L1')).toBe(true);

    // Wider spacing: fewer beams, same ids reused
    state = editorReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:bs-1', attrs: { spacing: '3' } });
    expect(beamsOf(state)).toHaveLength(2);
    expect(beamsOf(state).map(b => b.id).sort()).toEqual(['bm-1', 'bm-2']);
    // Another type: every beam follows
    state = editorReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:bs-1', attrs: { type_id: 'bmt-2' } });
    expect(beamsOf(state).every(b => b.attrs.size_y === '0.6' && b.attrs.type_id === 'bmt-2')).toBe(true);
    // The type picker (SET_ELEMENT_TYPE on the system) does the same
    state = editorReducer(state, { type: 'SET_ELEMENT_TYPE', ids: ['lv-1:bs-1'], typeId: 'bmt-1' });
    expect(beamsOf(state).every(b => b.attrs.type_id === 'bmt-1')).toBe(true);
    state = editorReducer(state, { type: 'UNDO' });
    // Turn 90°: beams along X
    state = editorReducer(state, { type: 'UPDATE_ATTRS', id: 'lv-1:bs-1', attrs: { direction: '0' } });
    expect(beamsOf(state).every(b => Math.abs(b.start.y - b.end.y) < 1e-9)).toBe(true);
    // One undo per edit
    state = editorReducer(state, { type: 'UNDO' });
    expect(beamsOf(state).every(b => Math.abs(b.start.x - b.end.x) < 1e-9)).toBe(true);
    state = editorReducer(state, { type: 'UNDO' });
    state = editorReducer(state, { type: 'UNDO' });
    expect(beamsOf(state)).toHaveLength(4);
    // Deleting the system deletes its beams
    state = editorReducer(state, { type: 'DELETE_ELEMENTS', ids: ['lv-1:bs-1'] });
    expect(beamsOf(state)).toHaveLength(0);
    state = editorReducer(state, { type: 'UNDO' });
    expect(beamsOf(state)).toHaveLength(4);
  });

  it('writes beam_system.csv and beam_system_id per spec', () => {
    const sys = { id: 'bs-1', tableName: 'beam_system', discipline: 'structure', geometry: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], attrs: { id: 'bs-1', spacing: '2', direction: '90', type_id: 'bmt-1' } } as unknown as CanonicalElement;
    const head = serializeToCsv([sys], 'beam_system').split('\n')[0].split(',');
    expect(head).toEqual(expect.arrayContaining(['id', 'spacing', 'direction', 'type_id']));
    expect(head).not.toContain('base_offset');
  });
});
