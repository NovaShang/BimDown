import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { LAYER_STYLES, DISCIPLINE_TABLES, DISCIPLINE_COLORS } from '../types.ts';
import { placementTypeForTable } from '../model/elements.ts';
import { getElementModule } from '../elements/registry.ts';
import type { PlacementType } from '../model/tableRegistry.ts';
import type { ToolbarVariant } from '../elements/archetypes.ts';
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

/** Keyboard shortcuts for drawing tools (key → tableName).
 *  Exported for use by useCanvasKeyboard. */
export const DRAW_TOOL_SHORTCUTS: Record<string, string> = {
  W: 'wall',
  D: 'door',
  N: 'window',
  C: 'column',
  R: 'space',
  F: 'slab',
  T: 'stair',
  E: 'equipment',
  P: 'pipe',
  U: 'duct',
};

/** Reverse lookup: tableName → shortcut key */
const TABLE_SHORTCUT: Record<string, string> = Object.fromEntries(
  Object.entries(DRAW_TOOL_SHORTCUTS).map(([k, v]) => [v, k]),
);

/** Architecture tool groups — tools within each group share a toolbar slot */
const ARCH_TOOL_GROUPS: { tools: string[] }[] = [
  { tools: ['wall', 'curtain_wall'] },
  { tools: ['space', 'room_separator'] },
  { tools: ['slab', 'ceiling'] },
  // Stair + its component parts (run, landing) collapse into one slot so the
  // hosted sub-elements don't clutter the toolbar as standalone tools.
  { tools: ['stair', 'stair_run', 'stair_landing'] },
  { tools: ['ramp', 'railing'] },
];

function toolForPlacement(placement: PlacementType): Tool {
  switch (placement) {
    case 'hosted': return 'draw_hosted';
    case 'free_line': return 'draw_line';
    case 'spatial_line': return 'draw_line';
    case 'free_point': return 'draw_point';
    case 'free_polygon': return 'draw_polygon';
    case 'grid': return 'draw_grid';
  }
}

function getDrawTool(tableName: string, variantId?: string): Tool {
  // V2 element modules declare their archetype, but DrawingOverlay still
  // checks specific tool names ('draw_line', etc.) to render the right
  // placement preview. So we keep the named-tool dispatch here; the new
  // archetype × operation lookup (tools/archetypes/index.ts) is the
  // architectural artifact, used by callers that don't need overlay support.
  if (variantId) {
    const mod = getElementModule(tableName);
    const variant = mod?.toolbarVariants?.find(v => v.id === variantId);
    if (variant) return toolForPlacement(variant.placementType);
  }
  return toolForPlacement(placementTypeForTable(tableName));
}

/** One entry in the toolbar — either a plain table or a variant of a table. */
interface ToolbarEntry {
  /** Stable react key. */
  key: string;
  /** Table name written to CSV. */
  table: string;
  /** Variant id (only set when this entry is one of a module's toolbarVariants). */
  variantId?: string;
  /** Resolved variant (for label/icon rendering); undefined for plain entries. */
  variant?: ToolbarVariant;
}

/** Expand a flat list of table names into toolbar entries, splitting tables
 *  that declare toolbarVariants into one entry per variant. */
function expandToolbarEntries(tables: string[]): ToolbarEntry[] {
  const out: ToolbarEntry[] = [];
  for (const table of tables) {
    const mod = getElementModule(table);
    const variants = mod?.toolbarVariants;
    if (variants && variants.length > 0) {
      for (const v of variants) {
        out.push({ key: `${table}:${v.id}`, table, variantId: v.id, variant: v });
      }
    } else {
      out.push({ key: table, table });
    }
  }
  return out;
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
          <span className="relative text-base leading-none">
            <Icon name={iconForTable(displayTable)} />
            {TABLE_SHORTCUT[displayTable] && <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">{TABLE_SHORTCUT[displayTable]}</kbd>}
          </span>
          <span className="whitespace-nowrap text-[9px] leading-none">{t(SHORT_LABEL_KEYS[displayTable] || `layer.${displayTable}`)}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {style ? t('draw.tooltip', { name: t(`display.${style.displayName}`) }) : displayTable}{TABLE_SHORTCUT[displayTable] ? ` (${TABLE_SHORTCUT[displayTable]})` : ''}
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

  // Grid has its own standalone button; modules can also opt out of the
  // toolbar (e.g. mep_node — users never place those directly).
  const disciplineTables = activeDiscipline
    ? (DISCIPLINE_TABLES[activeDiscipline] || []).filter(t => {
        if (t === 'grid') return false;
        return !getElementModule(t)?.hiddenFromToolbar;
      })
    : [];
  const disciplineColor = activeDiscipline ? (DISCIPLINE_COLORS[activeDiscipline] || '#888') : '#888';

  const handleDrawToolClick = useCallback((tableName: string, discipline: string, variantId?: string) => {
    const currentTarget = state.drawingTarget;
    if (
      currentTarget?.tableName === tableName
      && currentTarget?.discipline === discipline
      && (currentTarget?.variantId ?? undefined) === variantId
    ) {
      dispatch({ type: 'SET_TOOL', tool: 'select' });
      dispatch({ type: 'SET_DRAWING_TARGET', target: null });
      dispatch({ type: 'SET_DRAWING_STATE', state: null });
      return;
    }

    const drawTool = getDrawTool(tableName, variantId);
    dispatch({ type: 'SET_TOOL', tool: drawTool });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName, discipline, variantId } });
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
  const activeVariantId = state.drawingTarget?.variantId ?? null;

  // Expand variants into per-variant pseudo-entries for the flat (non-architecture)
  // rendering branch. Architecture groups never include variant-bearing modules
  // today (foundation lives in 'structure'), so we leave the group path alone.
  const flatEntries = expandToolbarEntries(disciplineTables);

  return (
    <div data-tour="toolbar" className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 glass-panel rounded-xl border border-border px-1.5 py-1 shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-2 duration-200">
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
              <span className="relative text-base leading-none">
                <Icon name={tool.icon} />
                <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">{tool.shortcut}</kbd>
              </span>
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
            <span className="relative text-base leading-none">
              <Icon name="grid" />
              <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">G</kbd>
            </span>
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
            // Non-architecture: flat list (with variant expansion)
            flatEntries.map(entry => {
              const style = LAYER_STYLES[entry.table];
              if (!style) return null;
              const isActive = activeTable === entry.table
                && state.drawingTarget?.discipline === activeDiscipline
                && (activeVariantId ?? undefined) === entry.variantId;
              return (
                <SingleToolButton
                  key={entry.key}
                  table={entry.table}
                  variant={entry.variant}
                  discipline={activeDiscipline!}
                  disciplineColor={disciplineColor}
                  isActive={isActive}
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
            <span className="relative text-base leading-none">
              <Icon name="undo" />
              <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">⌘Z</kbd>
            </span>
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
            <span className="relative text-base leading-none">
              <Icon name="redo" />
              <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">⌘Y</kbd>
            </span>
            <span className="whitespace-nowrap text-[9px] leading-none">{t('tool.redo')}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('tool.redo')} (Ctrl+Y)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ─── SingleToolButton ────────────────────────────────────────────────────────

function SingleToolButton({ table, variant, discipline, disciplineColor, isActive, onClick }: {
  table: string;
  /** When present, this button represents one toolbarVariant of `table`. */
  variant?: ToolbarVariant;
  discipline: string;
  disciplineColor: string;
  isActive: boolean;
  onClick: (table: string, discipline: string, variantId?: string) => void;
}) {
  const { t } = useTranslation();
  const style = LAYER_STYLES[table];

  // Variant entries use the variant's single-char icon (rendered as plain text)
  // and the variant's label/tooltip; no keyboard shortcut.
  const isVariant = !!variant;
  const shortcut = isVariant ? null : TABLE_SHORTCUT[table];
  const labelKey = variant?.label ?? SHORT_LABEL_KEYS[table] ?? `layer.${table}`;

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
        onClick={() => onClick(table, discipline, variant?.id)}
      >
        <span className="relative text-base leading-none">
          {isVariant
            ? <span className="inline-flex items-center justify-center" style={{ width: 22, height: 22, fontSize: 18, lineHeight: 1 }}>{variant!.icon}</span>
            : <Icon name={iconForTable(table)} />}
          {shortcut && <kbd className="absolute -top-0.5 -right-1.5 text-[9px] leading-none font-normal opacity-50 pointer-events-none">{shortcut}</kbd>}
        </span>
        <span className="whitespace-nowrap text-[9px] leading-none">{t(labelKey)}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isVariant
          ? t('draw.tooltip', { name: t(labelKey) })
          : (style ? t('draw.tooltip', { name: t(`display.${style.displayName}`) }) : table)}
        {shortcut ? ` (${shortcut})` : ''}
      </TooltipContent>
    </Tooltip>
  );
}
