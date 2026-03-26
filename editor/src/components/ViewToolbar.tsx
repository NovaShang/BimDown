import { useState, useRef, useEffect } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ViewMode, Floor3DMode } from '../state/editorTypes.ts';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

const FLOOR_3D_OPTIONS: { mode: Floor3DMode; label: string; title: string }[] = [
  { mode: 'current', label: 'Current', title: 'Show current floor only' },
  { mode: 'current+below', label: '+Below', title: 'Show current floor + one below' },
  { mode: 'all', label: 'All', title: 'Show all floors' },
];

interface ViewToolbarProps {
  onZoomToFit?: () => void;
  scale?: number;
}

export default function ViewToolbar({ onZoomToFit, scale }: ViewToolbarProps) {
  const { viewMode, floor3DMode, showMinimap } = useEditorState();
  const dispatch = useEditorDispatch();

  return (
    <div className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[0_4px_24px_rgba(0,0,0,0.4)] select-none">
      {/* 2D / 3D toggle */}
      {(['2d', '3d'] as const).map((mode: ViewMode) => (
        <Tooltip key={mode}>
          <TooltipTrigger
            className={cn(
              'flex size-8 cursor-pointer items-center justify-center rounded-lg border-none text-[11px] font-semibold uppercase transition-all',
              viewMode === mode
                ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode })}
          >
            {mode}
          </TooltipTrigger>
          <TooltipContent side="top">{mode === '2d' ? '2D View' : '3D View'}</TooltipContent>
        </Tooltip>
      ))}

      {/* Zoom to fit (both 2D and 3D) */}
      {onZoomToFit && (
        <>
          <Separator orientation="vertical" className="mx-0.5 self-stretch" />

          <Tooltip>
            <TooltipTrigger
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
              onClick={onZoomToFit}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7.5L8 3l5 4.5" />
                <path d="M4 7v5.5a.5.5 0 00.5.5h2.75V10h1.5v3h2.75a.5.5 0 00.5-.5V7" />
              </svg>
            </TooltipTrigger>
            <TooltipContent side="top">Zoom to Fit (⌘0)</TooltipContent>
          </Tooltip>
        </>
      )}

      {/* 2D-only: scale display */}
      {viewMode === '2d' && scale != null && (
        <span className="px-1 text-[10px] tabular-nums text-muted-foreground">
          {(scale * 100).toFixed(0)}%
        </span>
      )}

      {/* 3D-only: floor display mode dropdown */}
      {viewMode === '3d' && (
        <>
          <Separator orientation="vertical" className="mx-0.5 self-stretch" />
          <FloorModeDropdown floor3DMode={floor3DMode} onChange={(mode) => dispatch({ type: 'SET_FLOOR_3D_MODE', mode })} />
        </>
      )}

      {/* Minimap toggle */}
      {viewMode === '2d' && (
        <>
          <Separator orientation="vertical" className="mx-0.5 self-stretch" />
          <Tooltip>
            <TooltipTrigger
              className={cn(
                'flex size-8 cursor-pointer items-center justify-center rounded-lg border-none transition-all',
                showMinimap
                  ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                  : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              onClick={() => dispatch({ type: 'TOGGLE_MINIMAP' })}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="8" rx="1" />
                <rect x="4" y="4" width="4" height="3" rx="0.5" strokeWidth="1" />
              </svg>
            </TooltipTrigger>
            <TooltipContent side="top">Toggle Minimap (M)</TooltipContent>
          </Tooltip>
        </>
      )}

    </div>
  );
}

function FloorModeDropdown({ floor3DMode, onChange }: { floor3DMode: Floor3DMode; onChange: (mode: Floor3DMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [open]);

  const current = FLOOR_3D_OPTIONS.find(o => o.mode === floor3DMode)!;

  return (
    <div ref={ref} className="relative">
      <button
        className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border-none bg-transparent px-2 text-[10px] font-medium text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {current.label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 4l2 2 2-2" />
        </svg>
      </button>
      {open && (
        <div className="glass-panel absolute left-0 top-full mt-1 min-w-[140px] rounded-md border border-border py-1 shadow-xl animate-in fade-in duration-100">
          {FLOOR_3D_OPTIONS.map(({ mode, label, title }) => (
            <button
              key={mode}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-accent',
                floor3DMode === mode ? 'text-[var(--color-accent)]' : 'text-foreground'
              )}
              onClick={() => { onChange(mode); setOpen(false); }}
              title={title}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
