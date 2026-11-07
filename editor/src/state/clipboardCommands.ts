/**
 * Ctrl+C / Ctrl+X / Ctrl+V and Paste Aligned. The system clipboard carries
 * the copy as BimDown JSON (model/clipboard.ts), so it works across levels,
 * projects and tabs; an in-memory copy backs it up where the clipboard can't
 * be read (permissions, headless browsers).
 */
import type { EditorAction, EditorState } from './editorTypes.ts';
import { toElementId, toSelectionId } from '../model/ids.ts';
import { getProjectUnits } from '../utils/units.ts';
import {
  buildClipboard, parseClipboard, pasteElements, pasteNeedsTypesSaved, rememberClipboard, rememberedClipboard, serializeClipboard, type ClipboardPayload,
} from '../model/clipboard.ts';
import { startPaste } from '../tools/modifyTools.ts';
import { takenIds, type LevelPatches } from './levelEdits.ts';

type Dispatch = (a: EditorAction) => void;

export type PasteAligned = 'same' | 'current' | { levels: string[] };

/** The selection as a clipboard payload (null when nothing copyable is selected). */
export function clipboardFromSelection(state: EditorState): ClipboardPayload | null {
  const doc = state.document;
  if (!doc || !state.project) return null;
  const ids = [...state.selectedIds].map(toElementId);
  return buildClipboard(doc.elements, ids, {
    project: state.modelName, levelId: doc.levelId, levels: state.project.levels, units: getProjectUnits(state),
  });
}

/** Copy: remembered, and written to the system clipboard when allowed. Returns the JSON. */
export function copySelection(state: EditorState): string | null {
  const p = clipboardFromSelection(state);
  if (!p) return null;
  rememberClipboard(p);
  const text = serializeClipboard(p);
  try { void navigator.clipboard?.writeText(text).catch(() => {}); } catch { /* no clipboard API */ }
  return text;
}

export function cutSelection(state: EditorState, dispatch: Dispatch): boolean {
  if (!copySelection(state)) return false;
  dispatch({ type: 'DELETE_ELEMENTS', ids: [...state.selectedIds] });
  return true;
}

/** The payload to paste: system clipboard text if it is ours, else the remembered copy. */
export async function readClipboard(): Promise<ClipboardPayload | null> {
  try {
    const text = await navigator.clipboard?.readText();
    const p = parseClipboard(text);
    if (p) return p;
  } catch { /* not allowed */ }
  return rememberedClipboard();
}

export function canPasteHere(state: EditorState, p: ClipboardPayload): string | null {
  if (!state.document || !state.project) return 'paste.noLevel';
  if (p.units !== getProjectUnits(state)) return 'paste.unitsDiffer';
  return null;
}

/** Ctrl+V: the copy follows the cursor until a click places it. */
export function pasteAtCursor(state: EditorState, dispatch: Dispatch, p: ClipboardPayload): string | null {
  const err = canPasteHere(state, p);
  if (err) return err;
  startPaste(dispatch, p);
  return null;
}

/**
 * Paste Aligned: same plan coordinates on the source level (same place), on
 * the open level, or on each selected level. One undo step.
 */
export function pasteAligned(state: EditorState, dispatch: Dispatch, p: ClipboardPayload, where: PasteAligned): string | null {
  const err = canPasteHere(state, p);
  if (err) return err;
  const project = state.project!;
  const sameProject = p.project === state.modelName;
  const levels = typeof where === 'object'
    ? where.levels
    : where === 'same' && sameProject && project.levels.some(l => l.id === p.levelId) ? [p.levelId] : [state.currentLevel];
  const patches: LevelPatches = new Map();
  let select: string[] | undefined;
  for (const levelId of levels) {
    if (!project.levels.some(l => l.id === levelId)) continue;
    const { elements, selected } = pasteElements(p, levelId, project.levels, takenIds(state, levelId), { x: 0, y: 0 }, project.types);
    patches.set(levelId, new Map(elements.map(el => [el.id, el])));
    if (levelId === state.currentLevel) select = selected.map(id => toSelectionId(levelId, id));
  }
  if (patches.size === 0) return 'paste.noLevel';
  // Pasted types of an unsaved starter catalog must be written to the project
  if (pasteNeedsTypesSaved(p, project.types)) dispatch({ type: 'SET_TYPES', types: { ...project.types!, saved: true, fromDisk: false } });
  dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Paste aligned', patches, select });
  return null;
}
