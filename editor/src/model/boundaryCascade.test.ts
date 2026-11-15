import { describe, it, expect } from 'vitest';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import { pickAt, buildPick } from '../tools/drawPickTool.ts';
import type { CanonicalElement, LineElement, PolygonElement } from './elements.ts';
import type { EditorState } from '../state/editorTypes.ts';

const LEVELS = [
  { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
  { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
];

const of = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);
const bounds = (p: PolygonElement) => {
  const xs = p.vertices.map(v => v.x), ys = p.vertices.map(v => v.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 1000) / 1000);
};

/** A 10 × 6 box of 0.2 m walls and a floor picked from them (whole outline, at the wall centre lines). */
function boxWithFloor(table = 'slab', attrs: Record<string, string> = { __face: 'centerline' }) {
  const h = createHarness(LEVELS);
  h.pick('wall', { thickness: '0.2' });
  for (const [x, y] of [[0, 0], [10, 0], [10, 6], [0, 6], [0, 0]]) h.click(x, y);
  h.done();
  h.pick(table, attrs, 'by_walls');
  const pick = pickAt(h.state as never, { x: 5, y: 0 })!;
  const patch = buildPick(h.state as never, pick)!;
  h.dispatch({ type: 'APPLY_PATCH', description: 'by walls', patches: patch as Map<string, CanonicalElement | null> });
  h.done();
  return h;
}

describe('floors / roofs follow the walls they were picked from (N3)', () => {
  it('a floor by walls stores its walls and face; moving a wall moves its edge, one undo step', () => {
    const h = boxWithFloor();
    const slab = of(h.state, 'slab')[0] as PolygonElement;
    expect(slab.attrs.boundary_walls.split(';').sort()).toEqual(['w-1', 'w-2', 'w-3', 'w-4']);
    expect(slab.attrs.boundary_face).toBe('centerline');
    expect(bounds(slab)).toEqual([0, 0, 10, 6]);
    // Drag the right wall 2 m out (its neighbours stretch with it)
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-2'], dx: 2, dy: 0 });
    const right = (h.state.document!.elements.get('w-2') as LineElement);
    expect(right.start.x).toBeCloseTo(12, 6);
    expect(bounds(of(h.state, 'slab')[0] as PolygonElement)).toEqual([0, 0, 12, 6]);
    h.dispatch({ type: 'UNDO' });
    expect(bounds(of(h.state, 'slab')[0] as PolygonElement)).toEqual([0, 0, 10, 6]);
  });

  it('a core-face floor follows a flipped layered wall and a thicker wall', () => {
    const h = boxWithFloor('slab', { __face: 'interior' });
    expect(bounds(of(h.state, 'slab')[0] as PolygonElement)).toEqual([0.1, 0.1, 9.9, 5.9]);
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'w-2', attrs: { thickness: '0.4' } });
    expect(bounds(of(h.state, 'slab')[0] as PolygonElement)).toEqual([0.1, 0.1, 9.8, 5.9]);
  });

  it('moving the floor alone (its walls stay) makes it a sketch: later wall moves leave it', () => {
    const h = boxWithFloor();
    const id = of(h.state, 'slab')[0].id;
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: [id], dx: 1, dy: 0 });
    expect(of(h.state, 'slab')[0].attrs.boundary_walls).toBe('');
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-2'], dx: 2, dy: 0 });
    expect(bounds(of(h.state, 'slab')[0] as PolygonElement)).toEqual([1, 0, 11, 6]);
  });

  it('a roof by walls keeps its overhang when a wall moves', () => {
    const h = boxWithFloor('roof', { __overhang: '0.5', roof_type: 'flat', slope: '0' });
    const roof = of(h.state, 'roof')[0] as PolygonElement;
    expect(roof.attrs.boundary_offset).toBe('0.5');
    expect(bounds(roof)).toEqual([-0.6, -0.6, 10.6, 6.6]);
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: ['w-3'], dx: 0, dy: 1 });
    expect(bounds(of(h.state, 'roof')[0] as PolygonElement)).toEqual([-0.6, -0.6, 10.6, 7.6]);
  });

  it('saves the association columns', async () => {
    const files = await saveHarness(boxWithFloor());
    expect(files['lv-1/slab.csv']).toMatch(/boundary_walls/);
    expect(files['lv-1/slab.csv']).toMatch(/w-\d;w-\d;w-\d;w-\d,centerline/);
  });
});
