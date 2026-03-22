import type { ToolStateSnapshot } from './types.ts';

/** Find the next level above the current one for top_level_id defaults. */
export function resolveNextLevelId(state: ToolStateSnapshot): string {
  const currentLevelId = state.document?.levelId ?? '';
  const levels = state.project?.levels ?? [];
  const currentIdx = levels.findIndex(l => l.id === currentLevelId);
  if (currentIdx >= 0 && currentIdx + 1 < levels.length) return levels[currentIdx + 1].id;
  return currentLevelId;
}
