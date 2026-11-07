import type { CanonicalElement } from './elements.ts';
import type { FloorData, Level } from '../types.ts';

/** Project level list around a level add / remove / rename, plus the
 *  affected level's content when it is added or removed. */
export interface LevelSnapshot {
  levels: Level[];
  levelId: string;
  /** undefined = untouched (rename), null = the level doesn't exist. */
  floor?: FloorData | null;
}

export interface EditCommand {
  description: string;
  before: Map<string, CanonicalElement | null>;  // null = element didn't exist
  after: Map<string, CanonicalElement | null>;   // null = element was deleted
  /** Set for level commands (element maps are then empty). Unlike element
   *  commands these survive switching levels. */
  level?: { before: LevelSnapshot; after: LevelSnapshot };
  /** Consecutive commands with the same key fold into one undo step
   *  (typing a value into a multi-selection's field). */
  mergeKey?: string;
}

export interface HistoryState {
  undoStack: EditCommand[];
  redoStack: EditCommand[];
}

const MAX_HISTORY = 100;

export const emptyHistory: HistoryState = {
  undoStack: [],
  redoStack: [],
};

export function pushCommand(history: HistoryState, command: EditCommand): HistoryState {
  return {
    undoStack: [...history.undoStack, command].slice(-MAX_HISTORY),
    redoStack: [],  // clear redo on new edit
  };
}

export function applyUndo(
  history: HistoryState,
  elements: Map<string, CanonicalElement>,
): { history: HistoryState; elements: Map<string, CanonicalElement> } | null {
  if (history.undoStack.length === 0) return null;

  const command = history.undoStack[history.undoStack.length - 1];
  const newElements = new Map(elements);

  // Restore "before" state
  for (const [id, el] of command.before) {
    if (el === null) {
      newElements.delete(id);
    } else {
      newElements.set(id, el);
    }
  }

  return {
    history: {
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, command],
    },
    elements: newElements,
  };
}

export function applyRedo(
  history: HistoryState,
  elements: Map<string, CanonicalElement>,
): { history: HistoryState; elements: Map<string, CanonicalElement> } | null {
  if (history.redoStack.length === 0) return null;

  const command = history.redoStack[history.redoStack.length - 1];
  const newElements = new Map(elements);

  // Apply "after" state
  for (const [id, el] of command.after) {
    if (el === null) {
      newElements.delete(id);
    } else {
      newElements.set(id, el);
    }
  }

  return {
    history: {
      undoStack: [...history.undoStack, command],
      redoStack: history.redoStack.slice(0, -1),
    },
    elements: newElements,
  };
}

/**
 * Create a command from before/after element snapshots.
 */
export function createCommand(
  description: string,
  beforeElements: Map<string, CanonicalElement | null>,
  afterElements: Map<string, CanonicalElement | null>,
): EditCommand {
  return { description, before: beforeElements, after: afterElements };
}
