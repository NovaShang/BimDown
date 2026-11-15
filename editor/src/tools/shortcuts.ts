/**
 * Revit-style two-letter shortcuts (WA wall, MV move, RO rotate, …) on top
 * of the single keys. Typing the second letter within ~1.2 s runs the
 * two-letter command; the first letter's own single-key action (if any) is
 * undone first: tool and selection go back to what they were before it.
 * The cheat sheet (?, KS) lists these plus the single keys.
 */
import type { EditorAction, EditorState, Tool } from '../state/editorTypes.ts';
import { getElementModule } from '../elements/registry.ts';
import { placementTypeForTable } from '../model/elements.ts';
import { enterModifyTool } from './wallModifyTools.ts';
import { enterModifyToolFor } from './modifyTools.ts';
import { toElementId } from '../model/ids.ts';
import { isHostedTable } from '../model/tableRegistry.ts';
import { createGroup, selectAllInstances, selectedGroup, setPinned, ungroup } from '../state/selectionOps.ts';
import { openDialog, showNotice, toggleShortcuts } from '../state/modifyUi.ts';
import { ANNOTATION_DISCIPLINE } from '../annotation/model.ts';
import { matchType, resetTempHide, similarOf, tempHideSelection } from '../state/revitCommands.ts';

type Dispatch = (a: EditorAction) => void;

export interface ShortcutApi { state: EditorState; dispatch: Dispatch }

export type ShortcutGroup = 'draw' | 'annotate' | 'modify' | 'select' | 'view';

/** Where a single key acts: everywhere (unset), in a discipline's plan, while placing library furniture, in 3D. */
export type ShortcutContext = 'arch' | 'mep' | 'placing' | '3d';

export interface Shortcut {
  keys: string;
  labelKey: string;
  group: ShortcutGroup;
  context?: ShortcutContext;
  run?: (api: ShortcutApi) => void;
}

/** Letters the active place tool handles itself (module `placeKeys`): no two-letter sequence on them. */
export function claimedKeys(state: Pick<EditorState, 'activeTool' | 'drawingTarget'>): ReadonlySet<string> {
  if (state.activeTool !== 'draw_point' || !state.drawingTarget) return NONE;
  const keys = getElementModule(state.drawingTarget.tableName)?.placeKeys;
  return keys?.length ? new Set(keys.map(k => k.toUpperCase())) : NONE;
}
const NONE: ReadonlySet<string> = new Set();

const PLACEMENT_TO_TOOL: Record<string, Tool> = {
  hosted: 'draw_hosted', free_line: 'draw_line', spatial_line: 'draw_line',
  free_point: 'draw_point', free_polygon: 'draw_polygon', grid: 'draw_grid', region: 'draw_region',
};

/** Activate a placement tool, switching to its discipline first. */
export function startDrawing({ state, dispatch }: ShortcutApi, tableName: string) {
  const mod = getElementModule(tableName);
  if (!mod) return;
  if (state.activeDiscipline !== mod.discipline && state.activeDiscipline !== 'all') dispatch({ type: 'SET_DISCIPLINE', discipline: mod.discipline });
  if (tableName === 'grid') {
    dispatch({ type: 'SET_TOOL', tool: 'draw_grid' });
    dispatch({ type: 'SET_DRAWING_TARGET', target: null });
  } else {
    const tool = PLACEMENT_TO_TOOL[placementTypeForTable(tableName)];
    if (!tool) return;
    dispatch({ type: 'SET_TOOL', tool });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName, discipline: mod.discipline } });
  }
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}

function annotate({ dispatch }: ShortcutApi, tool: Tool, table: string) {
  dispatch({ type: 'SET_TOOL', tool });
  dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: table, discipline: ANNOTATION_DISCIPLINE } });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}

function needSelection(api: ShortcutApi): boolean {
  if (api.state.selectedIds.size > 0) return true;
  showNotice('notice.selectFirst');
  return false;
}

function relocate(api: ShortcutApi, mode: 'move' | 'copy') {
  if (!needSelection(api)) return;
  const { state, dispatch } = api;
  const ids = [...state.selectedIds];
  const one = ids.length === 1 ? state.document?.elements.get(toElementId(ids[0])) : undefined;
  if (mode === 'move' && one && isHostedTable(one.tableName)) {
    dispatch({ type: 'SET_TOOL', tool: 'relocate_hosted' });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    return;
  }
  dispatch({ type: 'SET_TOOL', tool: 'relocate' });
  dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: mode, discipline: '' } });
  dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
}

function modify(api: ShortcutApi, tool: Tool, opts?: { mirrorMode?: 'pick' | 'draw' }) {
  if (!enterModifyToolFor(api.dispatch, api.state, tool, opts)) showNotice('notice.selectFirst');
}

const columnTable = (s: EditorState) => (s.activeDiscipline === 'structure' ? 'structure_column' : 'column');

export const TWO_LETTER: Shortcut[] = [
  { keys: 'WA', labelKey: 'layer.wall', group: 'draw', run: a => startDrawing(a, 'wall') },
  { keys: 'DR', labelKey: 'layer.door', group: 'draw', run: a => startDrawing(a, 'door') },
  { keys: 'WN', labelKey: 'layer.window', group: 'draw', run: a => startDrawing(a, 'window') },
  { keys: 'CL', labelKey: 'layer.column', group: 'draw', run: a => startDrawing(a, columnTable(a.state)) },
  { keys: 'RM', labelKey: 'layer.space', group: 'draw', run: a => startDrawing(a, 'space') },
  { keys: 'SB', labelKey: 'layer.slab', group: 'draw', run: a => startDrawing(a, 'slab') },
  { keys: 'RF', labelKey: 'layer.roof', group: 'draw', run: a => startDrawing(a, 'roof') },
  { keys: 'ST', labelKey: 'layer.stair', group: 'draw', run: a => startDrawing(a, 'stair') },
  { keys: 'BM', labelKey: 'layer.beam', group: 'draw', run: a => startDrawing(a, 'beam') },
  { keys: 'DT', labelKey: 'layer.duct', group: 'draw', run: a => startDrawing(a, 'duct') },
  { keys: 'PI', labelKey: 'layer.pipe', group: 'draw', run: a => startDrawing(a, 'pipe') },
  { keys: 'GR', labelKey: 'layer.grid', group: 'draw', run: a => startDrawing(a, 'grid') },
  { keys: 'RP', labelKey: 'shortcut.referenceLine', group: 'draw', run: a => startDrawing(a, 'grid') },
  { keys: 'DI', labelKey: 'annot.dimension', group: 'annotate', run: a => annotate(a, 'draw_dimension', 'dimension') },
  { keys: 'TG', labelKey: 'annot.tag', group: 'annotate', run: a => annotate(a, 'draw_tag', 'tag') },
  { keys: 'TX', labelKey: 'annot.text', group: 'annotate', run: a => annotate(a, 'draw_text', 'text_note') },
  { keys: 'MV', labelKey: 'ctx.move', group: 'modify', run: a => relocate(a, 'move') },
  { keys: 'CO', labelKey: 'ctx.copy', group: 'modify', run: a => relocate(a, 'copy') },
  { keys: 'CC', labelKey: 'ctx.copy', group: 'modify', run: a => relocate(a, 'copy') },
  { keys: 'RO', labelKey: 'modify.rotate', group: 'modify', run: a => modify(a, 'rotate') },
  { keys: 'MM', labelKey: 'modify.mirrorPick', group: 'modify', run: a => modify(a, 'mirror', { mirrorMode: 'pick' }) },
  { keys: 'DM', labelKey: 'modify.mirrorDraw', group: 'modify', run: a => modify(a, 'mirror', { mirrorMode: 'draw' }) },
  { keys: 'AR', labelKey: 'modify.array', group: 'modify', run: a => modify(a, 'array') },
  { keys: 'AL', labelKey: 'modify.align', group: 'modify', run: a => modify(a, 'align') },
  { keys: 'OF', labelKey: 'modify.offset', group: 'modify', run: a => modify(a, 'offset') },
  { keys: 'TR', labelKey: 'tool.trimCornerTip', group: 'modify', run: a => enterModifyTool(a.dispatch, 'trim_corner') },
  { keys: 'SL', labelKey: 'tool.splitTip', group: 'modify', run: a => enterModifyTool(a.dispatch, 'split') },
  { keys: 'PN', labelKey: 'ctx.pin', group: 'modify', run: a => { if (needSelection(a)) setPinned(a.state, a.dispatch, true); } },
  { keys: 'UP', labelKey: 'ctx.unpin', group: 'modify', run: a => { if (needSelection(a)) setPinned(a.state, a.dispatch, false); } },
  { keys: 'GP', labelKey: 'ctx.createGroup', group: 'modify', run: a => { if (needSelection(a)) createGroup(a.state, a.dispatch); } },
  { keys: 'UG', labelKey: 'ctx.ungroup', group: 'modify', run: a => ungroup(a.state, a.dispatch) },
  { keys: 'EG', labelKey: 'ctx.editGroup', group: 'modify', run: a => {
    const g = selectedGroup(a.state);
    if (g) a.dispatch({ type: 'START_GROUP_EDIT', groupId: g.id }); else showNotice('notice.selectGroup');
  } },
  { keys: 'SA', labelKey: 'shortcut.selectAllInstances', group: 'select', run: a => { if (needSelection(a)) selectAllInstances(a.state, a.dispatch, 'view'); } },
  { keys: 'SF', labelKey: 'ctx.selectionFilter', group: 'select', run: a => { if (needSelection(a)) openDialog({ kind: 'filter' }); } },
  { keys: 'CS', labelKey: 'shortcut.createSimilar', group: 'draw', run: a => {
    const s = similarOf(a.state);
    if (!s) { showNotice('notice.selectFirst'); return; }
    startDrawing(a, s.tableName);
    if (s.typeId) a.dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...a.state.drawingAttrs, type_id: s.typeId } });
  } },
  { keys: 'MA', labelKey: 'shortcut.matchType', group: 'modify', run: a => {
    if (!needSelection(a)) return;
    showNotice('notice.matched', { count: matchType(a.state, a.dispatch) });
  } },
  { keys: 'HH', labelKey: 'shortcut.hideElement', group: 'view', run: a => { if (needSelection(a)) { tempHideSelection(a.state, 'hide', 'element'); a.dispatch({ type: 'CLEAR_SELECTION' }); } } },
  { keys: 'HI', labelKey: 'shortcut.isolateElement', group: 'view', run: a => { if (needSelection(a)) tempHideSelection(a.state, 'isolate', 'element'); } },
  { keys: 'HC', labelKey: 'shortcut.hideCategory', group: 'view', run: a => { if (needSelection(a)) { tempHideSelection(a.state, 'hide', 'category'); a.dispatch({ type: 'CLEAR_SELECTION' }); } } },
  { keys: 'IC', labelKey: 'shortcut.isolateCategory', group: 'view', run: a => { if (needSelection(a)) tempHideSelection(a.state, 'isolate', 'category'); } },
  { keys: 'HR', labelKey: 'shortcut.resetTempHide', group: 'view', run: () => resetTempHide() },
  { keys: 'VV', labelKey: 'vv.title', group: 'view', run: () => openDialog({ kind: 'visibility' }) },
  { keys: 'ZF', labelKey: 'ctx.zoomToFit', group: 'view', run: () => window.dispatchEvent(new Event('bimdown:zoom-fit')) },
  { keys: 'KS', labelKey: 'shortcut.title', group: 'view', run: () => toggleShortcuts() },
];

/** Single keys and key chords, listed in the cheat sheet (handled elsewhere). */
export const SINGLE_KEYS: Shortcut[] = [
  { keys: 'V', labelKey: 'tool.select', group: 'select' },
  { keys: 'Tab', labelKey: 'shortcut.tabCycle', group: 'select' },
  { keys: '⌘A', labelKey: 'ctx.selectAll', group: 'select' },
  { keys: 'Esc', labelKey: 'shortcut.escape', group: 'select' },
  { keys: '⌘C', labelKey: 'shortcut.copyClipboard', group: 'modify' },
  { keys: '⌘X', labelKey: 'ctx.cut', group: 'modify' },
  { keys: '⌘V', labelKey: 'ctx.paste', group: 'modify' },
  { keys: '⌘Z', labelKey: 'tool.undo', group: 'modify' },
  { keys: '⇧⌘Z', labelKey: 'tool.redo', group: 'modify' },
  { keys: 'Del', labelKey: 'ctx.delete', group: 'modify' },
  { keys: 'J', labelKey: 'tool.trimCornerTip', group: 'modify', context: 'arch' },
  { keys: 'E', labelKey: 'tool.trimSingleTip', group: 'modify', context: 'arch' },
  { keys: 'K', labelKey: 'tool.splitTip', group: 'modify', context: 'arch' },
  { keys: 'W', labelKey: 'layer.wall', group: 'draw', context: 'arch' },
  { keys: 'D', labelKey: 'layer.door', group: 'draw', context: 'arch' },
  { keys: 'N', labelKey: 'layer.window', group: 'draw', context: 'arch' },
  { keys: 'C', labelKey: 'layer.column', group: 'draw', context: 'arch' },
  { keys: 'R', labelKey: 'layer.space', group: 'draw', context: 'arch' },
  { keys: 'F', labelKey: 'layer.slab', group: 'draw', context: 'arch' },
  { keys: 'T', labelKey: 'layer.stair', group: 'draw', context: 'arch' },
  { keys: 'E', labelKey: 'layer.equipment', group: 'draw', context: 'mep' },
  { keys: 'P', labelKey: 'layer.pipe', group: 'draw', context: 'mep' },
  { keys: 'U', labelKey: 'layer.duct', group: 'draw', context: 'mep' },
  { keys: 'R', labelKey: 'shortcut.placeRotate', group: 'draw', context: 'placing' },
  { keys: 'M', labelKey: 'shortcut.placeMirror', group: 'draw', context: 'placing' },
  { keys: 'Space', labelKey: 'shortcut.placeSpace', group: 'draw', context: 'placing' },
  { keys: 'G', labelKey: 'layer.grid', group: 'draw' },
  { keys: 'M', labelKey: 'annot.dimension', group: 'annotate' },
  { keys: 'X', labelKey: 'annot.text', group: 'annotate' },
  { keys: 'H', labelKey: 'tool.pan', group: 'view' },
  { keys: 'O', labelKey: 'tool.orbit', group: 'view', context: '3d' },
  { keys: 'Z', labelKey: 'shortcut.zoom', group: 'view' },
  { keys: '⌘0', labelKey: 'ctx.zoomToFit', group: 'view' },
  { keys: '?', labelKey: 'shortcut.title', group: 'view' },
];

const FIRST = new Set(TWO_LETTER.map(s => s.keys[0]));
const BY_KEYS = new Map(TWO_LETTER.map(s => [s.keys, s]));
const WINDOW_MS = 1200;

/**
 * Key sequence tracker. `onKey` is called (capture phase, before any other
 * shortcut handler) with each plain letter; returns the shortcut to run when
 * the letter completes one, plus the state from before the sequence's first
 * letter (to restore what that letter's single-key action changed).
 */
export function createSequence() {
  let first: { key: string; at: number; tool: Tool; selection: Set<string> } | null = null;
  return {
    onKey(key: string, state: EditorState, now = Date.now()): { shortcut: Shortcut; before: { tool: Tool; selection: Set<string> } } | null {
      const k = key.toUpperCase();
      if (!/^[A-Z]$/.test(k) || claimedKeys(state).has(k)) { first = null; return null; }
      if (first && now - first.at <= WINDOW_MS) {
        const hit = BY_KEYS.get(first.key + k);
        if (hit) {
          const before = { tool: first.tool, selection: first.selection };
          first = null;
          return { shortcut: hit, before };
        }
      }
      first = FIRST.has(k) ? { key: k, at: now, tool: state.activeTool, selection: state.selectedIds } : null;
      return null;
    },
    reset() { first = null; },
  };
}
