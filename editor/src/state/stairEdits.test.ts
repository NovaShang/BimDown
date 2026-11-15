import { describe, it, expect } from 'vitest';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import type { EditorState } from './editorTypes.ts';
import type { LineElement, PolygonElement, SpatialLineElement } from '../model/elements.ts';

const els = (s: EditorState, table: string) => [...s.document!.elements.values()].filter(e => e.tableName === table);

function lStair() {
  const h = createHarness([
    { id: 'lv-1', number: '1', name: 'Level 1', elevation: 0 },
    { id: 'lv-2', number: '2', name: 'Level 2', elevation: 3 },
  ]);
  // Going 0.28: runs locked to 9 × 0.28 each (the clicks land on whole treads)
  h.pick('stair', { stair_type: 'quarter_turn', width: '1.2', step_count: '18', __going: '0.28' });
  h.click(0, 0); h.click(3.12, 0); h.click(3.12, 3.12);
  h.done();
  return h;
}

describe('stair tool and edits', () => {
  it('places an L stair with its run, landing and railings both sides, rising to the next level', () => {
    const h = lStair();
    const stair = els(h.state, 'stair')[0] as SpatialLineElement;
    const run = els(h.state, 'stair_run')[0] as SpatialLineElement;
    expect([stair.startZ, stair.endZ, run.startZ, run.endZ]).toEqual([0, 1.5, 1.5, 3]);
    expect(els(h.state, 'stair_landing')[0].attrs.base_offset).toBe('1.5');
    expect(els(h.state, 'railing').map(r => [r.attrs.host_id, r.attrs.side])).toEqual([[stair.id, 'left'], [stair.id, 'right']]);
  });

  it('more risers in a run re-share the rise; the landing follows', () => {
    const h = lStair();
    const run = els(h.state, 'stair_run')[0];
    h.dispatch({ type: 'UPDATE_ATTRS', id: run.id, attrs: { step_count: '11' } });
    const stair = els(h.state, 'stair')[0] as SpatialLineElement;
    const r = els(h.state, 'stair_run')[0] as SpatialLineElement;
    expect(stair.endZ).toBeCloseTo(9 * 3 / 20, 4);
    expect(r.startZ).toBeCloseTo(9 * 3 / 20, 4);
    expect(r.endZ).toBeCloseTo(3, 4);
    expect(parseFloat(els(h.state, 'stair_landing')[0].attrs.base_offset)).toBeCloseTo(1.35, 4);
    // one undo step restores all of it
    h.dispatch({ type: 'UNDO' });
    expect((els(h.state, 'stair_run')[0] as SpatialLineElement).startZ).toBe(1.5);
    expect(els(h.state, 'stair_landing')[0].attrs.base_offset).toBe('1.5');
  });

  it('moving the stair moves its runs and landings; deleting it removes parts and railings', () => {
    const h = lStair();
    const stair = els(h.state, 'stair')[0];
    h.dispatch({ type: 'MOVE_ELEMENTS', ids: [stair.id], dx: 10, dy: 5 });
    const start = (els(h.state, 'stair_run')[0] as LineElement).start;
    expect(start.x).toBeCloseTo(13.12, 9);
    expect(start.y).toBeCloseTo(5.6, 9);
    expect((els(h.state, 'stair_landing')[0] as PolygonElement).vertices[0].x).toBeCloseTo(12.52, 9);
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: [stair.id] });
    expect(['stair', 'stair_run', 'stair_landing', 'railing'].flatMap(t => els(h.state, t))).toHaveLength(0);
  });

  it('saves stair railings without geometry', async () => {
    const files = await saveHarness(lStair());
    expect(files['lv-1/railing.csv']).toMatch(/rl-1,.*st-1.*left/);
    expect(files['lv-1/railing.geojson'] ?? '').not.toContain('rl-1');
  });
});
