import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { LAYER_STYLES, DISCIPLINE_TABLES, DISCIPLINE_COLORS } from '../types.ts';
import { placementTypeForTable } from '../model/elements.ts';
import type { Tool } from '../state/editorTypes.ts';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Separator } from './ui/separator';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { cn } from '../lib/utils';

interface FloatingToolbarProps {
  activeDiscipline: string | null;
}

const SHORT_LABEL_KEYS: Record<string, string> = {
  wall: 'layer.wall',
  curtain_wall: 'layer.curtain_wall',
  column: 'layer.column',
  door: 'layer.door',
  window: 'layer.window',
  space: 'layer.space',
  slab: 'layer.slab',
  stair: 'layer.stair',
  structure_wall: 'layer.structure_wall',
  structure_column: 'layer.structure_column',
  structure_slab: 'layer.structure_slab',
  beam: 'layer.beam',
  brace: 'layer.brace',
  isolated_foundation: 'layer.isolated_foundation',
  strip_foundation: 'layer.strip_foundation',
  raft_foundation: 'layer.raft_foundation',
  duct: 'layer.duct',
  pipe: 'layer.pipe',
  conduit: 'layer.conduit',
  cable_tray: 'layer.cable_tray',
  equipment: 'layer.equipment',
  terminal: 'layer.terminal',
  grid: 'layer.grid',
};

const TOOLS: { tool: Tool; labelKey: string; icon: IconName; shortcut: string }[] = [
  { tool: 'select', labelKey: 'tool.select', icon: 'select', shortcut: 'V' },
  { tool: 'pan', labelKey: 'tool.pan', icon: 'pan', shortcut: 'H' },
];

function getDrawTool(tableName: string): Tool {
  const placement = placementTypeForTable(tableName);
  switch (placement) {
    case 'hosted': return 'draw_hosted';
    case 'free_line': return 'draw_line';
    case 'spatial_line': return 'draw_line';
    case 'free_point': return 'draw_point';
    case 'free_polygon': return 'draw_polygon';
    case 'grid': return 'draw_grid';
  }
}

export default function FloatingToolbar({ activeDiscipline }: FloatingToolbarProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  // Grid has its own standalone button, skip it from discipline tools
  const disciplineTables = activeDiscipline
    ? (DISCIPLINE_TABLES[activeDiscipline] || []).filter(t => t !== 'grid')
    : [];
  const disciplineColor = activeDiscipline ? (DISCIPLINE_COLORS[activeDiscipline] || '#888') : '#888';

  const handleDrawToolClick = (tableName: string, discipline: string) => {
    const currentTarget = state.drawingTarget;
    if (currentTarget?.tableName === tableName && currentTarget?.discipline === discipline) {
      dispatch({ type: 'SET_TOOL', tool: 'select' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      return;
    }

    const drawTool = getDrawTool(tableName);
    dispatch({ type: 'SET_TOOL', tool: drawTool });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName, discipline } });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  };

  const canUndo = state.history.undoStack.length > 0;
  const canRedo = state.history.redoStack.length > 0;

  return (
    <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* General tools */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(tool => (
          <Tooltip key={tool.tool}>
            <TooltipTrigger
              className={cn(
                'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
                state.activeTool === tool.tool
                  ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                  : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              onClick={() => {
                dispatch({ type: 'SET_TOOL', tool: tool.tool });
                dispatch({ type: 'SET_DRAWING_TARGET', target: null });
                dispatch({ type: 'SET_DRAWING_STATE', state: null });
              }}
            >
              <span className="text-base leading-none"><Icon name={tool.icon} /></span>
              <span className="whitespace-nowrap text-[9px] leading-none">{t(tool.labelKey)}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{t(tool.labelKey)} ({tool.shortcut})</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Grid tool — only in reference discipline */}
      {activeDiscipline === 'reference' && <>
      <Separator orientation="vertical" className="mx-1 self-stretch" />
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            className={cn(
              'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
              state.activeTool === 'draw_grid'
                ? 'bg-[color-mix(in_srgb,#ef476f_20%,transparent)] text-[#ef476f]'
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => {
              if (state.activeTool === 'draw_grid') {
                dispatch({ type: 'SET_TOOL', tool: 'select' });
                dispatch({ type: 'SET_DRAWING_STATE', state: null });
              } else {
                dispatch({ type: 'SET_TOOL', tool: 'draw_grid' });
                dispatch({ type: 'SET_DRAWING_TARGET', target: null });
                dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
              }
            }}
          >
            <span className="text-base leading-none"><Icon name="grid" /></span>
            <span className="whitespace-nowrap text-[9px] leading-none">{t('tool.grid')}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('draw.gridTooltip')}</TooltipContent>
        </Tooltip>
      </div>
      </>}

      {/* Separator */}
      {disciplineTables.length > 0 && <Separator orientation="vertical" className="mx-1 self-stretch" />}

      {/* Discipline drawing tools */}
      {disciplineTables.length > 0 && (
        <div className="flex items-center gap-0.5">
          {disciplineTables.map(table => {
            const style = LAYER_STYLES[table];
            if (!style) return null;
            const isActive = state.drawingTarget?.tableName === table &&
              state.drawingTarget?.discipline === activeDiscipline;
            return (
              <Tooltip key={table}>
                <TooltipTrigger
                  className={cn(
                    'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
                    isActive
                      ? 'text-[var(--tool-color)]'
                      : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                  style={{
                    '--tool-color': disciplineColor,
                    background: isActive ? `color-mix(in srgb, ${disciplineColor} 20%, transparent)` : undefined,
                  } as React.CSSProperties}
                  onClick={() => handleDrawToolClick(table, activeDiscipline!)}
                >
                  <span className="text-base leading-none"><Icon name={table} /></span>
                  <span className="whitespace-nowrap text-[9px] leading-none">{t(SHORT_LABEL_KEYS[table] || `layer.${table}`)}</span>
                </TooltipTrigger>
                <TooltipContent side="top">{t('draw.tooltip', { name: t(`display.${style.displayName}`) })}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* Separator */}
      <Separator orientation="vertical" className="mx-1 self-stretch" />

      {/* Undo/Redo */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            className={cn(
              'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
              'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              !canUndo && 'pointer-events-none opacity-50'
            )}
            onClick={() => canUndo && dispatch({ type: 'UNDO' })}
          >
            <span className="text-base leading-none"><Icon name="undo" /></span>
            <span className="whitespace-nowrap text-[9px] leading-none">{t('tool.undo')}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('tool.undo')} (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            className={cn(
              'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
              'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              !canRedo && 'pointer-events-none opacity-50'
            )}
            onClick={() => canRedo && dispatch({ type: 'REDO' })}
          >
            <span className="text-base leading-none"><Icon name="redo" /></span>
            <span className="whitespace-nowrap text-[9px] leading-none">{t('tool.redo')}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('tool.redo')} (Ctrl+Y)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
