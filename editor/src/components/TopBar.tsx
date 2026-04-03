import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { DISCIPLINES } from '../model/tableRegistry.ts';
import type { ViewMode } from '../state/editorTypes.ts';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

export default function TopBar() {
  const { viewMode, activeDiscipline } = useEditorState();
  const dispatch = useEditorDispatch();

  return (
    <div data-tour="topbar" className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] select-none animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Discipline selector */}
      <Select value={activeDiscipline ?? DISCIPLINES[0]} onValueChange={(v) => { if (v) dispatch({ type: 'SET_DISCIPLINE', discipline: v }); }}>
        <SelectTrigger className="h-8 gap-1.5 border-none bg-transparent px-2.5 text-[11px] font-medium shadow-none hover:bg-accent">
          <span>{activeDiscipline ? activeDiscipline.charAt(0).toUpperCase() + activeDiscipline.slice(1) : ''}</span>
        </SelectTrigger>
        <SelectContent side="bottom" sideOffset={8} alignItemWithTrigger={false}>
          {DISCIPLINES.map(d => (
            <SelectItem key={d} value={d} className="text-[11px]">
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Separator orientation="vertical" className="mx-0.5 self-stretch" />

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
