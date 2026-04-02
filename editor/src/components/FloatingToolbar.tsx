import { useState, useRef, useEffect, useCallback } from 'react';
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

/** Map table names to icon names (handles space→room rename) */
const ICON_FOR_TABLE: Record<string, IconName> = {
  space: 'room',
};
function iconForTable(table: string): IconName {
  return ICON_FOR_TABLE[table] || (table as IconName);
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
  roof: 'layer.roof',
  ceiling: 'layer.ceiling',
  opening: 'layer.opening',
  room_separator: 'layer.room_separator',
  ramp: 'layer.ramp',
  railing: 'layer.railing',
  structure_wall: 'layer.structure_wall',
  structure_column: 'layer.structure_column',
  structure_slab: 'layer.structure_slab',
  beam: 'layer.beam',
  brace: 'layer.brace',
  foundation: 'layer.foundation',
  isolated_foundation: 'layer.isolated_foundation',
  strip_foundation: 'layer.strip_foundation',
  raft_foundation: 'layer.raft_foundation',
  duct: 'layer.duct',
  pipe: 'layer.pipe',
  conduit: 'layer.conduit',
  cable_tray: 'layer.cable_tray',
  equipment: 'layer.equipment',
  terminal: 'layer.terminal',
  mep_node: 'layer.mep_node',
  grid: 'layer.grid',
};

const TOOLS_2D: { tool: Tool; labelKey: string; icon: IconName; shortcut: string }[] = [
  { tool: 'select', labelKey: 'tool.select', icon: 'select', shortcut: 'V' },
  { tool: 'pan', labelKey: 'tool.pan', icon: 'pan', shortcut: 'H' },
];

const TOOLS_3D: { tool: Tool; labelKey: string; icon: IconName; shortcut: string }[] = [
  { tool: 'select', labelKey: 'tool.select', icon: 'select', shortcut: 'V' },
  { tool: 'orbit', labelKey: 'tool.orbit', icon: 'orbit', shortcut: 'O' },
];

/** Architecture tool groups — tools within each group share a toolbar slot */
const ARCH_TOOL_GROUPS: { tools: string[] }[] = [
  { tools: ['wall', 'curtain_wall'] },
  { tools: ['space', 'room_separator'] },
  { tools: ['slab', 'ceiling'] },
  { tools: ['stair', 'ramp', 'railing'] },
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

// ─── ToolGroupButton ─────────────────────────────────────────────────────────

interface ToolGroupButtonProps {
  tools: string[];
  discipline: string;
  disciplineColor: string;
  activeTable: string | null;
  activeDiscipline: string | null;
  onToolClick: (table: string, discipline: string) => void;
}

function ToolGroupButton({ tools, discipline, disciplineColor, activeTable, activeDiscipline, onToolClick }: ToolGroupButtonProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // If the active tool is in this group, show it
  const activeIdx = activeTable && activeDiscipline === discipline
    ? tools.indexOf(activeTable)
    : -1;
  const displayIdx = activeIdx >= 0 ? activeIdx : selectedIndex;
  const displayTable = tools[displayIdx];
  const isActive = activeIdx >= 0;

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleMainClick = useCallback(() => {
    onToolClick(displayTable, discipline);
  }, [displayTable, discipline, onToolClick]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(prev => !prev);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setOpen(prev => !prev);
  }, []);

  const handleSelect = useCallback((table: string, idx: number) => {
    setSelectedIndex(idx);
    setOpen(false);
    onToolClick(table, discipline);
  }, [discipline, onToolClick]);

  const style = LAYER_STYLES[displayTable];

  return (
    <div ref={containerRef} className="relative flex">
      {/* Main tool button — suppress tooltip while dropdown is open */}
      <Tooltip open={open ? false : undefined}>
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
          onClick={handleMainClick}
          onContextMenu={handleContextMenu}
        >
          <span className="text-base leading-none"><Icon name={iconForTable(displayTable)} /></span>
          <span className="whitespace-nowrap text-[9px] leading-none">{t(SHORT_LABEL_KEYS[displayTable] || `layer.${displayTable}`)}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {style ? t('draw.tooltip', { name: t(`display.${style.displayName}`) }) : displayTable}
        </TooltipContent>
      </Tooltip>
      {/* Expand arrow — separate right-side strip with upward chevron */}
      <button
        className={cn(
          'flex w-3.5 cursor-pointer items-center justify-center self-stretch rounded-r-lg border-none transition-all',
          open
            ? 'bg-accent text-foreground'
            : 'bg-transparent text-muted-foreground/50 hover:bg-accent hover:text-foreground'
        )}
        onClick={handleExpandClick}
        tabIndex={-1}
      >
        <svg width="8" height="5" viewBox="0 0 8 5">
          <path d="M0 4.5 L4 0.5 L8 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 glass-panel rounded-lg border border-border py-1 shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-1 duration-150"
          style={{ minWidth: '7rem' }}
        >
          {tools.map((table, idx) => {
            const isItemActive = activeTable === table && activeDiscipline === discipline;
            return (
              <button
                key={table}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                  isItemActive
                    ? 'text-[var(--tool-color)]'
                    : 'text-foreground hover:bg-accent'
                )}
                style={{ '--tool-color': disciplineColor } as React.CSSProperties}
                onClick={() => handleSelect(table, idx)}
              >
                <Icon name={iconForTable(table)} width={16} height={16} />
                <span>{t(SHORT_LABEL_KEYS[table] || `layer.${table}`)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── FloatingToolbar ─────────────────────────────────────────────────────────

export default function FloatingToolbar({ activeDiscipline }: FloatingToolbarProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const tools = state.viewMode === '3d' ? TOOLS_3D : TOOLS_2D;

  // Grid has its own standalone button, skip it from discipline tools
  const disciplineTables = activeDiscipline
    ? (DISCIPLINE_TABLES[activeDiscipline] || []).filter(t => t !== 'grid')
    : [];
  const disciplineColor = activeDiscipline ? (DISCIPLINE_COLORS[activeDiscipline] || '#888') : '#888';

  const handleDrawToolClick = useCallback((tableName: string, discipline: string) => {
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
  }, [state.drawingTarget, dispatch]);

  const canUndo = state.history.undoStack.length > 0;
  const canRedo = state.history.redoStack.length > 0;

  // Build architecture toolbar items as an ordered list of groups and singles
  const isArchitecture = activeDiscipline === 'architecture';

  // Build a lookup: table → group (filtered to available tables)
  const archItems: ({ type: 'group'; tools: string[] } | { type: 'single'; table: string })[] = [];
  if (isArchitecture) {
    const groupForTable = new Map<string, string[]>();
    const resolvedGroups: string[][] = [];
    for (const g of ARCH_TOOL_GROUPS) {
      const filtered = g.tools.filter(t => disciplineTables.includes(t));
      if (filtered.length > 0) {
        resolvedGroups.push(filtered);
        for (const t of filtered) groupForTable.set(t, filtered);
      }
    }
    const emitted = new Set<string[]>();
    for (const table of disciplineTables) {
      const group = groupForTable.get(table);
      if (group && !emitted.has(group)) {
        emitted.add(group);
        archItems.push(group.length === 1 ? { type: 'single', table: group[0] } : { type: 'group', tools: group });
      } else if (!group) {
        archItems.push({ type: 'single', table });
      }
    }
  }

  const activeTable = state.drawingTarget?.tableName ?? null;

  return (
    <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* General tools */}
      <div className="flex items-center gap-0.5">
        {tools.map(tool => (
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
          {isArchitecture ? (
            <>
              {archItems.map((item, i) =>
                item.type === 'group' ? (
                  <ToolGroupButton
                    key={i}
                    tools={item.tools}
                    discipline={activeDiscipline!}
                    disciplineColor={disciplineColor}
                    activeTable={activeTable}
                    activeDiscipline={state.drawingTarget?.discipline ?? null}
                    onToolClick={handleDrawToolClick}
                  />
                ) : (
                  <SingleToolButton
                    key={item.table}
                    table={item.table}
                    discipline={activeDiscipline!}
                    disciplineColor={disciplineColor}
                    isActive={activeTable === item.table && state.drawingTarget?.discipline === activeDiscipline}
                    onClick={handleDrawToolClick}
                  />
                )
              )}
            </>
          ) : (
            // Non-architecture: flat list
            disciplineTables.map(table => {
              const style = LAYER_STYLES[table];
              if (!style) return null;
              return (
                <SingleToolButton
                  key={table}
                  table={table}
                  discipline={activeDiscipline!}
                  disciplineColor={disciplineColor}
                  isActive={activeTable === table && state.drawingTarget?.discipline === activeDiscipline}
                  onClick={handleDrawToolClick}
                />
              );
            })
          )}
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

// ─── SingleToolButton ────────────────────────────────────────────────────────

function SingleToolButton({ table, discipline, disciplineColor, isActive, onClick }: {
  table: string;
  discipline: string;
  disciplineColor: string;
  isActive: boolean;
  onClick: (table: string, discipline: string) => void;
}) {
  const { t } = useTranslation();
  const style = LAYER_STYLES[table];

  return (
    <Tooltip>
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
        onClick={() => onClick(table, discipline)}
      >
        <span className="text-base leading-none"><Icon name={iconForTable(table)} /></span>
        <span className="whitespace-nowrap text-[9px] leading-none">{t(SHORT_LABEL_KEYS[table] || `layer.${table}`)}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {style ? t('draw.tooltip', { name: t(`display.${style.displayName}`) }) : table}
      </TooltipContent>
    </Tooltip>
  );
}
