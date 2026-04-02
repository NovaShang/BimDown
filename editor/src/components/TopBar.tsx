import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { DISCIPLINES, DISCIPLINE_COLORS } from '../model/tableRegistry.ts';
import type { ViewMode } from '../state/editorTypes.ts';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

export default function TopBar() {
  const { t } = useTranslation();
  const { viewMode, activeDiscipline } = useEditorState();
  const dispatch = useEditorDispatch();

  return (
    <div className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] select-none animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Discipline tabs */}
      <div className="flex items-center gap-0.5">
        {DISCIPLINES.map(d => (
          <button
            key={d}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-lg border-none px-2.5 py-1.5 text-[11px] font-medium transition-all',
              activeDiscipline === d
                ? 'bg-[var(--accent-dim)] text-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            style={activeDiscipline === d ? {
              '--accent-dim': `color-mix(in srgb, ${DISCIPLINE_COLORS[d]} 15%, transparent)`,
            } as React.CSSProperties : undefined}
            onClick={() => dispatch({ type: 'SET_DISCIPLINE', discipline: d })}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: DISCIPLINE_COLORS[d] }}
            />
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>

      <Separator orientation="vertical" className="mx-1 self-stretch" />

      {/* 2D / 3D toggle */}
      <div className="flex items-center gap-0.5">
        {(['2d', '3d'] as const).map((mode: ViewMode) => (
          <button
            key={mode}
            className={cn(
              'flex size-8 cursor-pointer items-center justify-center rounded-lg border-none text-[11px] font-semibold uppercase transition-all',
              viewMode === mode
                ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode })}
          >
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}
