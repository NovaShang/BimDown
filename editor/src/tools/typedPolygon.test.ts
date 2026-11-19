import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { drawPolygonTool } from './drawPolygonTool.ts';
import type { ToolContext, ToolStateSnapshot } from './types.ts';
import { createDocument } from '../model/document.ts';

/** Drives the polygon tool's typed vertices with a fake context. */
function harness() {
  const actions: any[] = [];
  let ds: any = { points: [], cursor: { x: 30, y: 30 } };
  const state = () => ({
    drawingTarget: { tableName: 'foundation', discipline: 'structure', variantId: 'pile_cap' },
    drawingAttrs: { kind: 'pile_cap', thickness: '1' },
    drawingState: ds, document: createDocument('lv-1', []), project: { levels: [], floors: new Map(), metadata: { units: 'm' } },
    grids: [], disabledSnapTypes: new Set(), currentLevel: 'lv-1',
  } as unknown as ToolStateSnapshot);
  const ctx = {
    getState: state,
    dispatch: (a: any) => { actions.push(a); if (a.type === 'SET_DRAWING_STATE') ds = a.state; },
    setSnap: () => {},
  } as unknown as ToolContext;
  const key = (k: string) => drawPolygonTool.onKeyDown!(ctx, { key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {} } as unknown as KeyboardEvent);
  const type = (s: string) => { for (const k of s.split(' ')) key(k === 'TAB' ? 'Tab' : k === 'ENTER' ? 'Enter' : k); };
  return { actions, key, type, points: () => ds.points as { x: number; y: number }[] };
}

describe('typed polygon vertices (precise pile cap / slab outlines)', () => {
  it('X Tab Y Enter, then length Tab angle Enter, @ΔX Tab ΔY; back on the first vertex closes', () => {
    const h = harness();
    // first vertex at (20.4, 24.0)
    h.type('2 0 . 4 TAB 2 4 ENTER');
    expect(h.points()).toEqual([{ x: 20.4, y: 24 }]);
    // 2.4 along 0°
    h.type('2 . 4 TAB 0 ENTER');
    expect(h.points()[1]).toEqual({ x: 22.8, y: 24 });
    // 2.4 along 90°
    h.type('2 . 4 TAB 9 0 ENTER');
    expect(h.points()[2]).toEqual({ x: 22.8, y: 26.4 });
    // @ -2.4, 0
    h.key('@');
    h.type('- 2 . 4 TAB 0 ENTER');
    expect(h.points()[3]).toEqual({ x: 20.4, y: 26.4 });
    // @ 0, -2.4: back on the first vertex → the cap is created
    h.key('@');
    h.type('0 TAB - 2 . 4 ENTER');
    const created = h.actions.find(a => a.type === 'CREATE_ELEMENT');
    expect(created.element.tableName).toBe('foundation');
    expect(created.element.vertices).toEqual([{ x: 20.4, y: 24 }, { x: 22.8, y: 24 }, { x: 22.8, y: 26.4 }, { x: 20.4, y: 26.4 }]);
  });

  it('Enter with nothing typed is left to the canvas (closes the outline)', () => {
    const h = harness();
    expect(h.key('Enter')).toBe(false);
  });
});
