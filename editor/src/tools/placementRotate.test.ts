import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { rotatePlacement } from './placementRotate.ts';
import type { EditorAction } from '../state/editorTypes.ts';

describe('space bar while placing', () => {
  const run = (activeTool: string, tableName: string, drawingAttrs: Record<string, string>, dir: 1 | -1 = 1) => {
    const out: EditorAction[] = [];
    const ok = rotatePlacement({ activeTool, drawingTarget: { tableName, discipline: 'architecture' }, drawingAttrs } as never, a => out.push(a), dir);
    return { ok, attrs: (out[0] as { attrs?: Record<string, string> } | undefined)?.attrs };
  };
  it('turns point elements with a rotation by 90°, flips a door, ignores the rest', () => {
    expect(run('draw_point', 'furniture', { rotation: '270' }).attrs?.rotation).toBe('0');
    expect(run('draw_point', 'terminal', { rotation: '0' }, -1).attrs?.rotation).toBe('270');
    expect(run('draw_point', 'column', {}).attrs?.rotation).toBe('90');
    expect(run('draw_hosted', 'door', { swing_side: 'left' }).attrs?.swing_side).toBe('right');
    expect(run('draw_line', 'wall', {}).ok).toBe(false);
    expect(run('draw_point', 'space', {}).ok).toBe(false);
  });
});
