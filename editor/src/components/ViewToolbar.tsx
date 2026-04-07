import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { Floor3DMode } from '../state/editorTypes.ts';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

interface ViewToolbarProps {
  onZoomToFit?: () => void;
  scale?: number;
}

export default function ViewToolbar({ onZoomToFit, scale }: ViewToolbarProps) {
  const { t } = useTranslation();
  const { viewMode, floor3DMode, showMinimap } = useEditorState();
  const dispatch = useEditorDispatch();

  return (
    <div data-tour="viewbar" className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] select-none">
      {/* Zoom to fit (both 2D and 3D) */}
      {onZoomToFit && (
        <>

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
            <TooltipContent side="top">{t('view.zoomToFit')} (⌘0)</TooltipContent>
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
            <TooltipContent side="top">{t('view.toggleMinimap')} (M)</TooltipContent>
          </Tooltip>
        </>
      )}

    </div>
  );
}

const FLOOR_3D_OPTIONS: { mode: Floor3DMode; labelKey: string }[] = [
  { mode: 'current', labelKey: 'view.floor.current' },
  { mode: 'current+below', labelKey: 'view.floor.below' },
  { mode: 'all', labelKey: 'view.floor.all' },
];

function FloorModeDropdown({ floor3DMode, onChange }: { floor3DMode: Floor3DMode; onChange: (mode: Floor3DMode) => void }) {
  const { t } = useTranslation();

  return (
    <Select value={floor3DMode} onValueChange={(v) => onChange(v as Floor3DMode)}>
      <SelectTrigger size="sm" className="h-7 border-none bg-transparent px-2 text-[10px] font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
        <span className="truncate">{t(FLOOR_3D_OPTIONS.find(o => o.mode === floor3DMode)?.labelKey ?? '')}</span>
      </SelectTrigger>
      <SelectContent side="top" sideOffset={8} alignItemWithTrigger={false}>
        {FLOOR_3D_OPTIONS.map(({ mode, labelKey }) => (
          <SelectItem key={mode} value={mode} className="text-[11px]">
            {t(labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
