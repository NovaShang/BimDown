import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { persistDocument } from '../utils/persist.ts';
import { rootReducer } from '../state/EditorContext.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { load } from '../test/annotationFixture.ts';
import {
  resolveRefPoint, dimensionGeometry, formatDimension, parseDimensionInput, tagLines, resolveDimension,
} from './geometry.ts';
import { tagPosition } from '../elements/tag.tsx';

const get = (s: EditorState, id: string) => s.document!.elements.get(id)!;
const lookupIn = (s: EditorState) => (id: string) => s.document!.elements.get(id);

describe('annotation geometry', () => {
  it('parses annotation rows into elements', async () => {
    const { state } = await load();
    const dm = get(state, 'dm-1') as LineElement;
    expect(dm.geometry).toBe('line');
    expect(dm.start).toEqual({ x: 0, y: 2.5 });
    expect(get(state, 'tx-1').geometry).toBe('point');
    expect(get(state, 'tg-2').geometry).toBe('point');
  });

  it('resolves references like the CLI', async () => {
    const { state } = await load();
    const lk = lookupIn(state);
    expect(resolveRefPoint('w-2', { x: 9, y: 3 }, lk)).toEqual({ x: 10, y: 3 });
    expect(resolveRefPoint('w-2:left', { x: 9, y: 3 }, lk).x).toBeCloseTo(9.9);
    expect(resolveRefPoint('w-1:end', { x: 0, y: 0 }, lk)).toEqual({ x: 10, y: 0 });
    expect(resolveRefPoint('d-1:start', { x: 0, y: 0 }, lk).x).toBeCloseTo(1.55);
    expect(resolveRefPoint('nope', { x: 1, y: 2 }, lk)).toEqual({ x: 1, y: 2 });
    const g = resolveDimension(get(state, 'dm-1'), lk)!;
    expect(g.value).toBeCloseTo(10);
    expect(g.d1.y).toBeCloseTo(1.5); // offset −1 along the left normal of +X (= +Y) → below
  });

  it('measures along a direction and formats drafting values', () => {
    const g = dimensionGeometry({ x: 0, y: 0 }, { x: 3, y: 1 }, 0, 1)!;
    expect(g.value).toBeCloseTo(3);
    expect(g.d1).toEqual({ x: 0, y: 1 });
    expect(formatDimension(3.6, 'm')).toBe('3600');
    expect(formatDimension(12.5, 'ft')).toBe(`12'-6"`);
    expect(parseDimensionInput('3600', 'm')).toBeCloseTo(3.6);
    expect(parseDimensionInput('3.6', 'm')).toBeCloseTo(3.6);
    expect(parseDimensionInput(`12'6"`, 'ft')).toBeCloseTo(12.5);
  });

  it('room tags show name, number and area; unpinned tags sit at the host', async () => {
    const { state } = await load();
    const room = get(state, 'sp-1');
    expect(tagLines(room, 'auto', 50)).toEqual(['Office', '101', '50.00 m²']);
    expect(tagLines(get(state, 'd-1'), 'size', null)).toEqual(['900×2100']);
    const tg1 = get(state, 'tg-1');
    expect(tagPosition(tg1, room, lookupIn(state))).toEqual({ x: 5, y: 2.5 });
  });
});

describe('annotation associativity', () => {
  it('a moved wall drags the dimension end and is saved', async () => {
    const { ds, state } = await load();
    const s = rootReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:w-2'], dx: 2, dy: 0 });
    const dm = get(s, 'dm-1') as LineElement;
    expect(dm.end.x).toBeCloseTo(12);
    expect(dm.attrs.end_x).toBe('12');
    expect(resolveDimension(dm, lookupIn(s))!.value).toBeCloseTo(12);
    expect(s.lastMutation!.keys).toContain('annotation/dimension');
    await persistDocument(s.document!, ds, new Set(s.lastMutation!.keys));
    expect(ds.files['lv-1/dimension.csv']).toContain('dm-1,0,2.5,12,2.5,w-4,w-2,0,-1,');
    expect(ds.files['lv-1/dimension.csv'].split('\n')[0]).toBe('id,start_x,start_y,end_x,end_y,start_ref,end_ref,direction,offset,text');
    expect(ds.files['lv-1/dimension.geojson']).toBeUndefined();
    // Undo restores wall and dimension together
    const u = rootReducer(s, { type: 'UNDO' });
    expect((get(u, 'dm-1') as LineElement).end.x).toBeCloseTo(10);
  });

  it('deleting a referenced wall leaves a fixed dimension, never a dangling ref', async () => {
    const { state } = await load();
    const s = rootReducer(state, { type: 'DELETE_ELEMENTS', ids: ['lv-1:w-2'] });
    const dm = get(s, 'dm-1');
    expect(dm.attrs.end_ref).toBe('');
    expect(dm.attrs.start_ref).toBe('w-4');
    expect(dm.attrs.end_x).toBe('10');
  });

  it('dragging a referenced dimension moves its line, not its ends', async () => {
    const { state } = await load();
    const s = rootReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:dm-1'], dx: 0.5, dy: -0.75 });
    const dm = get(s, 'dm-1') as LineElement;
    expect(dm.start).toEqual({ x: 0, y: 2.5 });
    expect(parseFloat(dm.attrs.offset)).toBeCloseTo(-1.75);
  });

  it('pinned tags follow their host; tags of a deleted host go with it', async () => {
    const { state } = await load();
    const moved = rootReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:w-1'], dx: 0, dy: -1 });
    expect(get(moved, 'tg-2').attrs.y).toBe('-2.5');
    const del = rootReducer(state, { type: 'DELETE_ELEMENTS', ids: ['lv-1:d-1'] });
    expect(del.document!.elements.has('tg-2')).toBe(false);
    expect(rootReducer(del, { type: 'UNDO' }).document!.elements.has('tg-2')).toBe(true);
  });

  it('an unpinned tag follows its host; dragging it pins it', async () => {
    const { state } = await load();
    const tg1 = get(state, 'tg-1');
    expect(tg1.attrs.x).toBe('');
    const s = rootReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:sp-1'], dx: 1, dy: 0 });
    const t1 = get(s, 'tg-1') as CanonicalElement & { position: { x: number } };
    expect(t1.attrs.x).toBe('');
    expect(t1.position.x).toBeCloseTo(6);
    const dragged = rootReducer(s, { type: 'MOVE_ELEMENTS', ids: ['lv-1:tg-1'], dx: 0, dy: 1 });
    const t2 = get(dragged, 'tg-1');
    expect(t2.attrs.x).toBe('6');
    expect(t2.attrs.y).toBe('3.5');
  });

  it('text note x/y follow a move', async () => {
    const { state } = await load();
    const s = rootReducer(state, { type: 'MOVE_ELEMENTS', ids: ['lv-1:tx-1'], dx: 1, dy: 1 });
    expect(get(s, 'tx-1').attrs.x).toBe('6');
    expect(get(s, 'tx-1').attrs.y).toBe('8');
  });
});
