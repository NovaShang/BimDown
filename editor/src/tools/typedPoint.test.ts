import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { drawPointTool } from './drawPointTool.ts';
import type { ToolContext, ToolStateSnapshot } from './types.ts';
import { createDocument } from '../model/document.ts';

/** Drives the point tool's typed offset with a fake context. */
function harness() {
  const actions: any[] = [];
  let ds: any = { points: [], cursor: { x: 21.6, y: 16.8 } };
  const state = () => ({
    drawingTarget: { tableName: 'foundation', discipline: 'structure', variantId: 'pile' },
    drawingAttrs: { kind: 'pile', width: '0.6', length: '', thickness: '15' },
    drawingState: ds, document: createDocument('lv-1', []), project: { levels: [], floors: new Map(), metadata: { units: 'm' } },
    grids: [], disabledSnapTypes: new Set(), currentLevel: 'lv-1',
  } as unknown as ToolStateSnapshot);
  const ctx = {
    getState: state,
    dispatch: (a: any) => { actions.push(a); if (a.type === 'SET_DRAWING_STATE') ds = a.state; },
    setSnap: () => {},
  } as unknown as ToolContext;
  const key = (k: string) => drawPointTool.onKeyDown!(ctx, { key: k, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
  return { actions, key };
}

describe('typed point placement', () => {
  it('ΔX Tab ΔY Enter places at that offset from the snapped reference', () => {
    const h = harness();
    for (const k of ['0', '.', '7', '5']) h.key(k);
    expect(h.key('0')).toBe(true);
    h.key('Backspace');
    h.key('Tab');
    for (const k of ['0', '.', '7', '5']) h.key(k);
    h.key('Enter');
    const created = h.actions.find(a => a.type === 'CREATE_ELEMENT');
    expect(created.element.tableName).toBe('foundation');
    expect(created.element.position.x).toBeCloseTo(21.6 + 0.75, 9);
    expect(created.element.position.y).toBeCloseTo(16.8 + 0.75, 9);
    expect(created.element.attrs.kind).toBe('pile');
  });

  it('negative offsets: "-" opens a value while placing points', () => {
    const h = harness();
    for (const k of ['-', '0', '.', '7', '5', 'Tab', '-', '1', '.', '5', 'Enter']) h.key(k);
    const created = h.actions.find(a => a.type === 'CREATE_ELEMENT');
    expect(created.element.position.x).toBeCloseTo(20.85, 9);
    expect(created.element.position.y).toBeCloseTo(15.3, 9);
  });
});
