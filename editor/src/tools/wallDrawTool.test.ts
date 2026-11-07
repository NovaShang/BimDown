import { describe, expect, it } from 'vitest';
import '../elements/registerAll.ts';
import { editorReducer, initialState } from '../state/editorReducer.ts';
import type { EditorAction, EditorState } from '../state/editorTypes.ts';
import type { ToolContext } from './types.ts';
import type { LineElement } from '../model/elements.ts';
import type { SnapType } from '../utils/snap.ts';
import { createDocument } from '../model/document.ts';
import { wallDrawTool, WALL_OPT } from './wallDrawTool.ts';
import { relocateTool } from './relocateTool.ts';
import { splitTool, trimCornerTool } from './wallModifyTools.ts';

const NO_SNAP = new Set<SnapType>(['endpoint', 'center', 'gridline', 'edge', 'midpoint', 'angle', 'length', 'grid', 'connector']);

/** Headless editor: the reducer plus a ToolContext whose screen is 100 px per metre. */
function harness(attrs: Record<string, string> = {}) {
  let state: EditorState = {
    ...initialState,
    loading: false,
    currentLevel: 'lv-1',
    disabledSnapTypes: NO_SNAP,
    project: { levels: [{ id: 'lv-1', name: 'L1', elevation: 0 }], floors: new Map(), globalLayers: [], mepSystems: [] } as unknown as EditorState['project'],
  };
  const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
  dispatch({ type: 'INIT_DOCUMENT', document: createDocument('lv-1', []) });
  dispatch({ type: 'SET_TOOL', tool: 'draw_line' });
  dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: 'wall', discipline: 'architecture' } });
  dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...state.drawingAttrs, thickness: '0.2', ...attrs } });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  const ctx = {
    dispatch: dispatch as ToolContext['dispatch'],
    svgRef: { current: null }, containerRef: { current: null },
    getState: () => ({ ...state, transform: { x: 0, y: 0, scale: 1 }, grids: state.grids }),
    screenToSvg: (cx: number, cy: number) => ({ x: cx / 100, y: -cy / 100 }),
    findElementId: () => null,
    setSnap: () => {},
  } as unknown as ToolContext;
  const ev = (x: number, y: number) => ({ button: 0, clientX: x * 100, clientY: -y * 100 }) as React.PointerEvent;
  const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }) as KeyboardEvent;
  return {
    ctx, get state() { return state; }, dispatch,
    click: (x: number, y: number, tool = wallDrawTool) => tool.onPointerDown!(ctx, ev(x, y)),
    move: (x: number, y: number, tool = wallDrawTool) => tool.onPointerMove!(ctx, ev(x, y)),
    type: (s: string, tool = wallDrawTool) => { for (const c of s) tool.onKeyDown!(ctx, key(c)); },
    key: (k: string, tool = wallDrawTool) => tool.onKeyDown!(ctx, key(k)),
    walls: () => [...state.document!.elements.values()]
      .filter((e): e is LineElement => e.tableName === 'wall')
      .map(w => [w.id, [+w.start.x.toFixed(3), +w.start.y.toFixed(3)], [+w.end.x.toFixed(3), +w.end.y.toFixed(3)]]),
  };
}

describe('wall chain drawing', () => {
  it('draws a closed 10 × 8 m house from typed lengths with two clicks', () => {
    const h = harness();
    h.click(0, 0);
    h.move(3, 0); h.type('10'); h.key('Enter');
    h.move(10, 3); h.type('8'); h.key('Enter');
    h.move(5, 8); h.type('10'); h.key('Enter');
    h.click(0, 0); // close on the start
    expect(h.walls()).toEqual([
      ['w-1', [0, 0], [10, 0]], ['w-2', [10, 0], [10, 8]], ['w-3', [10, 8], [0, 8]], ['w-4', [0, 8], [0, 0]],
    ]);
    expect(h.state.drawingState?.points).toEqual([]); // closing ends the chain
    expect(h.state.history.undoStack.length).toBe(4);
    const attrs = (h.state.document!.elements.get('w-1') as LineElement).attrs;
    expect(Object.keys(attrs).some(k => k.startsWith('__'))).toBe(false);
  });

  it('typed angle after Tab sets the direction', () => {
    const h = harness();
    h.click(1, 1);
    h.move(5, 1); h.type('2'); h.key('Tab'); h.type('90'); h.key('Enter');
    expect(h.walls()).toEqual([['w-1', [1, 1], [1, 3]]]);
  });

  it('a second click on the same point (double-click) and Enter end the chain', () => {
    const h = harness();
    h.click(0, 0); h.click(4, 0); h.click(4, 0);
    expect(h.state.drawingState?.points).toEqual([]);
    h.click(8, 0); h.click(8, 3); h.key('Enter');
    expect(h.state.drawingState?.points).toEqual([]);
    expect(h.walls().length).toBe(2);
  });

  it('exterior-face location insets the walls and keeps the corners joined', () => {
    const h = harness({ [WALL_OPT.loc]: 'exterior' });
    // clockwise: exterior (left of travel) is outside
    h.click(0, 0); h.click(0, 4); h.click(5, 4); h.click(5, 0); h.click(0, 0);
    expect(h.walls()).toEqual([
      ['w-1', [0.1, 0.1], [0.1, 3.9]], ['w-2', [0.1, 3.9], [4.9, 3.9]],
      ['w-3', [4.9, 3.9], [4.9, 0.1]], ['w-4', [4.9, 0.1], [0.1, 0.1]],
    ]);
  });

  it('rectangle mode with typed width / height', () => {
    const h = harness({ [WALL_OPT.mode]: 'rect' });
    h.click(2, 2); h.move(3, 3); h.type('6'); h.key('Tab'); h.type('4'); h.key('Enter');
    const w = h.walls();
    expect(w.length).toBe(4);
    expect(w[0]).toEqual(['w-1', [2, 6], [8, 6]]);
  });

  it('a wall started inside another wall seats on its centreline (tee join)', () => {
    const h = harness();
    h.click(0, 0); h.click(10, 0); h.key('Enter');
    h.click(5, 0.08); h.click(5, 4); h.key('Enter');
    expect(h.walls()[1]).toEqual(['w-2', [5, 0], [5, 4]]);
  });

  it('a chain continues from a seated end, not from the raw click', () => {
    const h = harness();
    h.click(0, 0); h.click(10, 0); h.key('Enter');
    h.click(5, 4); h.click(5, 0.08); h.click(8, 2);
    expect(h.walls().slice(1)).toEqual([['w-2', [5, 4], [5, 0]], ['w-3', [5, 0], [8, 2]]]);
  });

  it('arc mode makes an arc wall through the third point', () => {
    const h = harness({ [WALL_OPT.mode]: 'arc' });
    h.click(0, 0); h.click(6, 0); h.click(3, 3);
    const w = h.state.document!.elements.get('w-1') as LineElement;
    expect(w.arc?.rx).toBeCloseTo(3);
  });
});

describe('modify tools through the reducer', () => {
  it('move with typed distance drags the joined walls; undo restores', () => {
    const h = harness();
    h.click(0, 0); h.click(10, 0); h.click(10, 8); h.click(0, 8); h.click(0, 0);
    h.dispatch({ type: 'SELECT', ids: ['lv-1:w-2'] });
    h.dispatch({ type: 'SET_TOOL', tool: 'relocate' });
    h.dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: 'move', discipline: '' } });
    h.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    h.click(10, 4, relocateTool); h.move(12, 4, relocateTool); h.type('1', relocateTool); h.key('Enter', relocateTool);
    expect(h.walls()).toEqual([
      ['w-1', [0, 0], [11, 0]], ['w-2', [11, 0], [11, 8]], ['w-3', [11, 8], [0, 8]], ['w-4', [0, 8], [0, 0]],
    ]);
    h.dispatch({ type: 'UNDO' });
    expect(h.walls()[0]).toEqual(['w-1', [0, 0], [10, 0]]);
  });

  it('length edit (RESIZE_ELEMENT) drags the corner neighbour', () => {
    const h = harness();
    h.click(0, 0); h.click(4, 0); h.click(4, 3); h.key('Enter');
    h.dispatch({ type: 'RESIZE_ELEMENT', id: 'w-1', changes: { end: { x: 6, y: 0 } } });
    expect(h.walls()).toEqual([['w-1', [0, 0], [6, 0]], ['w-2', [6, 0], [4, 3]]]);
    h.dispatch({ type: 'UNDO' });
    expect(h.walls()).toEqual([['w-1', [0, 0], [4, 0]], ['w-2', [4, 0], [4, 3]]]);
  });

  it('trim/extend to corner and split tools', () => {
    const h = harness();
    h.click(0, 0); h.click(4, 0); h.key('Enter');
    h.click(5, 1); h.click(5, 4); h.key('Enter');
    h.dispatch({ type: 'SET_TOOL', tool: 'trim_corner' });
    h.click(1, 0, trimCornerTool); h.click(5, 3, trimCornerTool);
    expect(h.walls()).toEqual([['w-1', [0, 0], [5, 0]], ['w-2', [5, 0], [5, 4]]]);
    h.dispatch({ type: 'SET_TOOL', tool: 'split' });
    h.click(2, 0, splitTool);
    expect(h.walls()).toEqual([['w-1', [0, 0], [2, 0]], ['w-2', [5, 0], [5, 4]], ['w-3', [2, 0], [5, 0]]]);
  });
});
