/**
 * Per-user plan / 3D display options (persisted in localStorage):
 * element tags, structure shown in the architecture view, grid bubbles at
 * both ends, grids drawn in 3D.
 */
export interface ViewOptions {
  /** Draw element marks (`number`) as plan tags: KZ1, KL3, F2… */
  showElementNumbers: boolean;
  /** Architecture view shows structural columns, walls and slabs (Revit-style). */
  showStructureInArch: boolean;
  /** Grid bubbles at both ends of each axis, not only the start. */
  gridBubblesBothEnds: boolean;
  /** Draw grid axes in the 3D view. */
  showGrids3D: boolean;
}

export type ViewOptionKey = keyof ViewOptions;

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  showElementNumbers: false,
  showStructureInArch: true,
  gridBubblesBothEnds: false,
  showGrids3D: true,
};

const STORAGE_KEY = 'bimdown-view-options';

export function loadViewOptions(): ViewOptions {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ViewOptions>;
      const out = { ...DEFAULT_VIEW_OPTIONS };
      for (const k of Object.keys(out) as ViewOptionKey[]) {
        if (typeof saved[k] === 'boolean') out[k] = saved[k]!;
      }
      return out;
    }
  } catch { /* ignore malformed / unavailable storage */ }
  return { ...DEFAULT_VIEW_OPTIONS };
}

export function saveViewOptions(opts: ViewOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
  } catch { /* ignore unavailable storage */ }
}
