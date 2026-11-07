import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { TWO_LETTER, SINGLE_KEYS, createSequence, claimedKeys, type ShortcutContext } from './shortcuts.ts';
import { DRAW_TOOL_SHORTCUTS } from '../components/FloatingToolbar.tsx';
import { MODIFY_TOOL_SHORTCUTS } from './wallModifyTools.ts';
import { ANNOTATION_ENTRIES } from '../components/AnnotationTools.tsx';
import { allElementModules, getElementModule } from '../elements/registry.ts';
import { initialState } from '../state/editorReducer.ts';
import type { EditorState } from '../state/editorTypes.ts';

const CONTEXT_OF: Record<string, ShortcutContext> = { architecture: 'arch', structure: 'arch', mep: 'mep' };
const listed = (keys: string, ctx?: ShortcutContext) => SINGLE_KEYS.some(s => s.keys === keys && s.context === ctx);

describe('shortcut table', () => {
  it('two-letter shortcuts are unique', () => {
    const keys = TWO_LETTER.map(s => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(k => /^[A-Z]{2}$/.test(k))).toBe(true);
  });

  it('lists every single key the editor binds (tools, modify, annotation, placement)', () => {
    for (const [k, table] of Object.entries(DRAW_TOOL_SHORTCUTS)) {
      expect(listed(k, CONTEXT_OF[getElementModule(table)!.discipline]), `${k} ${table}`).toBe(true);
    }
    for (const k of Object.keys(MODIFY_TOOL_SHORTCUTS)) expect(listed(k, 'arch'), k).toBe(true);
    for (const e of ANNOTATION_ENTRIES) if (e.shortcut) expect(listed(e.shortcut), e.shortcut).toBe(true);
    for (const m of allElementModules()) for (const k of m.placeKeys ?? []) expect(listed(k, 'placing'), `${m.table} ${k}`).toBe(true);
  });

  it('no single key is bound twice in one context (global keys count everywhere)', () => {
    const global = SINGLE_KEYS.filter(s => !s.context).map(s => s.keys);
    expect(new Set(global).size).toBe(global.length);
    for (const ctx of ['arch', 'mep', '3d'] as const) {
      const keys = [...global, ...SINGLE_KEYS.filter(s => s.context === ctx).map(s => s.keys)];
      expect(new Set(keys).size, ctx).toBe(keys.length);
    }
  });

  it('a placing tool keeps its letters: R then M rotates and mirrors furniture, no RM (room) sequence', () => {
    const placing = { ...initialState, activeTool: 'draw_point', drawingTarget: { tableName: 'furniture', discipline: 'architecture' } } as EditorState;
    expect([...claimedKeys(placing)].sort()).toEqual(['M', 'R']);
    const seq = createSequence();
    expect(seq.onKey('r', placing, 0)).toBeNull();
    expect(seq.onKey('m', placing, 100)).toBeNull();
    expect(seq.onKey('m', placing, 200)).toBeNull(); // nor MM (mirror tool)
    const idle = { ...initialState, activeTool: 'select' } as EditorState;
    expect(claimedKeys(idle).size).toBe(0);
    seq.onKey('r', idle, 1000);
    expect(seq.onKey('m', idle, 1100)?.shortcut.keys).toBe('RM');
  });
});
