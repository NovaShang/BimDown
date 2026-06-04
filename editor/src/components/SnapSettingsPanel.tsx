import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { SnapType } from '../utils/snap.ts';
import { cn } from '../lib/utils';

/** User-facing snap toggles. Each maps to one or more engine snap types.
 *  "Grid line" folds the 轴网 line-snap and the round grid-distance snap
 *  together so they turn on/off as one. */
const SNAP_CATEGORIES: { labelKey: string; types: SnapType[] }[] = [
  { labelKey: 'snap.endpoint', types: ['endpoint'] },
  { labelKey: 'snap.midpoint', types: ['midpoint'] },
  { labelKey: 'snap.center', types: ['center'] },
  { labelKey: 'snap.edge', types: ['edge'] },
  { labelKey: 'snap.gridline', types: ['gridline', 'grid'] },
  { labelKey: 'snap.angle', types: ['angle'] },
  { labelKey: 'snap.length', types: ['length'] },
  { labelKey: 'snap.connector', types: ['connector'] },
];

/** True while the user is in a snap-using interaction (drawing or moving).
 *  The snap panel is shown and the top discipline bar is hidden in this state,
 *  since both occupy the same top-center slot. */
export function isSnapInteraction(activeTool: string, drawingState: unknown | null): boolean {
  return (
    activeTool.startsWith('draw') ||
    activeTool.startsWith('relocate') ||
    drawingState !== null
  );
}

/** Floating panel that appears only while a snap-using interaction is active
 *  (drawing or moving) and lets the user toggle which snap types are on. */
export default function SnapSettingsPanel() {
  const { t } = useTranslation();
  const { activeTool, drawingState, disabledSnapTypes } = useEditorState();
  const dispatch = useEditorDispatch();

  if (!isSnapInteraction(activeTool, drawingState)) return null;

  return (
    <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] select-none">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {t('snap.title')}
      </span>
      {SNAP_CATEGORIES.map(({ labelKey, types }) => {
        const on = types.every(ty => !disabledSnapTypes.has(ty));
        return (
          <button
            key={labelKey}
            type="button"
            onClick={() => dispatch({ type: 'TOGGLE_SNAP_CATEGORY', types })}
            className={cn(
              'cursor-pointer rounded-lg border-none px-2 py-1 text-[11px] transition-all',
              on
                ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                : 'bg-transparent text-muted-foreground opacity-50 hover:bg-accent hover:text-foreground hover:opacity-100'
            )}
          >
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}
