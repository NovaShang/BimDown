import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { starterCatalog } from '../model/types/starter.ts';
import { matchTypeOnto } from './revitCommands.ts';
import { matchTypeTool, enterMatchType } from '../tools/matchTypeTool.ts';
import type { ToolContext, ToolStateSnapshot } from '../tools/types.ts';
import type { EditorAction } from './editorTypes.ts';

const wall = (id: string, typeId: string, attrs: Record<string, string> = {}): LineElement => ({
  id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
  start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, strokeWidth: 0.2, attrs: { id, type_id: typeId, thickness: '', ...attrs },
});
const door: CanonicalElement = {
  id: 'd-1', tableName: 'door', discipline: 'architecture', geometry: 'line',
  start: { x: 1, y: 0 }, end: { x: 2, y: 0 }, strokeWidth: 0.1, attrs: { id: 'd-1', host_id: 'w-1' },
} as LineElement;

const catalog = starterCatalog();
const els = () => new Map<string, CanonicalElement>([
  ['w-1', wall('w-1', 'wt-ext-concrete-eps')], ['w-2', wall('w-2', 'wt-int-stud-100')],
  ['w-3', wall('w-3', '', { thickness: '0.3' })], ['d-1', door],
]);

describe('match type properties', () => {
  it('gives a target of the source category the source type, one target at a time', () => {
    const r = matchTypeOnto(els(), 'w-1', 'w-2', catalog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.patches.keys()]).toEqual(['w-2']);
    expect(r.patches.get('w-2')!.attrs.type_id).toBe('wt-ext-concrete-eps');
    // An untyped wall takes the type too; another category or the same type does not
    expect(matchTypeOnto(els(), 'w-1', 'w-3', catalog).ok).toBe(true);
    expect(matchTypeOnto(els(), 'w-1', 'd-1', catalog)).toEqual({ ok: false, reason: 'incompatible' });
    expect(matchTypeOnto(els(), 'w-1', 'w-1', catalog)).toEqual({ ok: false, reason: 'unchanged' });
  });

  it('pick flow: source, then each click a separate undo step, until Esc', () => {
    const actions: EditorAction[] = [];
    let state: Partial<ToolStateSnapshot> = {
      document: { elements: els() } as ToolStateSnapshot['document'],
      project: { types: catalog } as ToolStateSnapshot['project'],
      drawingState: null, hoveredId: null,
    };
    let under = 'w-1';
    const ctx = {
      dispatch: (a: EditorAction) => {
        actions.push(a);
        if (a.type === 'SET_DRAWING_STATE') state = { ...state, drawingState: a.state };
      },
      getState: () => state as ToolStateSnapshot,
      screenToSvg: () => ({ x: 0, y: 0 }),
      findElementId: () => null,
      screenToScenePoint: () => ({ elementId: under, x: 0, y: 0, elevation: 0 }),
    } as unknown as ToolContext;
    const click = (id: string) => { under = id; matchTypeTool.onPointerDown!(ctx, { button: 0, clientX: 0, clientY: 0 } as React.PointerEvent); };
    enterMatchType(ctx.dispatch as never, null);
    expect(actions[0]).toEqual({ type: 'SET_TOOL', tool: 'match_type' });
    click('w-1');
    expect(state.drawingState?.pick?.id).toBe('w-1');
    click('w-2');
    click('w-3');
    click('d-1');
    const patches = actions.filter(a => a.type === 'APPLY_PATCH');
    expect(patches).toHaveLength(2);
    expect(patches.map(a => a.type === 'APPLY_PATCH' && [...a.patches.keys()][0])).toEqual(['w-2', 'w-3']);
    expect(matchTypeTool.onKeyDown!(ctx, { key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(actions.at(-3)).toEqual({ type: 'SET_TOOL', tool: 'select' });
  });

  it('entered with one element selected, that element is the source', () => {
    const actions: EditorAction[] = [];
    enterMatchType(a => actions.push(a), 'lv-1:w-1');
    const ds = actions.find(a => a.type === 'SET_DRAWING_STATE');
    expect(ds && ds.type === 'SET_DRAWING_STATE' && ds.state?.pick?.id).toBe('w-1');
  });
});
