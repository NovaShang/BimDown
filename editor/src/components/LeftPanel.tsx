import { useState, useEffect, useRef } from 'react';
import type { Level } from '../types.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { LayerGroup } from '../state/editorTypes.ts';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { Icon } from './Icons.tsx';
import { cn } from '../lib/utils';
import AddLevelDialog from './AddLevelDialog.tsx';

interface LeftPanelProps {
  levels: Level[];
  currentLevel: string;
  layerGroups: LayerGroup[];
  visibleLayers: Set<string>;
}

/** Inline context menu for level items */
function LevelContextMenu({
  x, y, level, onRename, onDelete, onClose,
}: {
  x: number; y: number; level: Level;
  onRename: () => void; onDelete: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[120px] rounded-md border border-border bg-card py-1 shadow-xl"
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
        onClick={() => { onRename(); onClose(); }}
      >
        Rename
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-red-400 hover:bg-accent"
        onClick={() => { onDelete(); onClose(); }}
      >
        Delete
      </button>
    </div>
  );
}

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
}: LeftPanelProps) {
  const dispatch = useEditorDispatch();
  const { activeDiscipline, viewMode: rawViewMode, floor3DMode } = useEditorState();
  const viewMode = rawViewMode ?? '2d';
  const [showAddLevel, setShowAddLevel] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; level: Level } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Level | null>(null);

  const currentGroup = layerGroups.find(g => g.discipline === activeDiscipline);
  const currentGroupLayers = currentGroup ? [...currentGroup.layers].sort((a, b) => {
    const oa = LAYER_STYLES[a.tableName]?.order ?? 99;
    const ob = LAYER_STYLES[b.tableName]?.order ?? 99;
    return oa - ob;
  }) : [];

  return (
    <div className="flex h-full w-60 min-w-60 flex-col overflow-hidden border-r border-border bg-card select-none">
      {/* 2D / 3D Toggle */}
      <div className="flex shrink-0 gap-0.5 px-2 pt-2">
        {(['2d', '3d'] as const).map(mode => (
          <button
            key={mode}
            className={cn(
              'flex-1 rounded py-[5px] text-[11px] font-semibold uppercase transition-all',
              'border cursor-pointer',
              viewMode === mode
                ? 'border-[var(--color-accent)] bg-[var(--accent-dim)] text-[var(--color-accent)]'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode })}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Floor Switcher */}
      <div className="max-h-[35%] shrink-0 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Floors
          </span>
          <button
            className="flex size-4 cursor-pointer items-center justify-center rounded border-none bg-transparent text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setShowAddLevel(true)}
            title="Add level"
          >
            +
          </button>
        </div>
        <div className="flex flex-col gap-px">
          {viewMode === '3d' && (
            <div className="mb-1 flex gap-0.5">
              {(['current', 'current+below', 'all'] as const).map(mode => (
                <button
                  key={mode}
                  className={cn(
                    'flex-1 rounded py-[5px] text-[11px] font-semibold transition-all',
                    'border cursor-pointer',
                    floor3DMode === mode
                      ? 'border-[var(--color-accent)] bg-[var(--accent-dim)] text-[var(--color-accent)]'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                  onClick={() => dispatch({ type: 'SET_FLOOR_3D_MODE', mode })}
                  title={mode === 'current' ? 'Show current floor only' : mode === 'current+below' ? 'Show current floor + one below' : 'Show all floors'}
                >
                  {mode === 'current' ? 'Current' : mode === 'current+below' ? '+Below' : 'All'}
                </button>
              ))}
            </div>
          )}
          {levels.map(level => (
            <button
              key={level.id}
              className={cn(
                'flex items-center justify-between rounded px-2 py-[5px] text-[11px] transition-all',
                'border cursor-pointer text-left',
                currentLevel === level.id
                  ? 'border-[var(--color-accent)] bg-[var(--accent-dim)] font-medium text-[var(--color-accent)]'
                  : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              onClick={() => dispatch({ type: 'SET_LEVEL', levelId: level.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, level });
              }}
              title={`${level.name} (${level.elevation}m)`}
            >
              <span className="flex-1 truncate">{level.name || level.id}</span>
              <span className={cn(
                'ml-2 text-[9px] tabular-nums',
                currentLevel === level.id ? 'text-[var(--color-accent)] opacity-60' : 'text-muted-foreground'
              )}>
                {level.elevation.toFixed(1)}m
              </span>
            </button>
          ))}
        </div>
      </div>

      <Separator />

      {/* Discipline Switcher */}
      <div className="max-h-[35%] shrink-0 overflow-y-auto p-2">
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Disciplines
        </div>
        <div className="flex flex-col gap-px">
          {layerGroups.map(group => {
            const color = DISCIPLINE_COLORS[group.discipline] || '#888';
            return (
              <button
                key={group.discipline}
                className={cn(
                  'flex items-center justify-between rounded px-2 py-[5px] text-[11px] transition-all',
                  'border cursor-pointer text-left',
                  activeDiscipline === group.discipline
                    ? 'border-[var(--color-accent)] bg-[var(--accent-dim)] font-medium text-[var(--color-accent)]'
                    : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
                onClick={() => dispatch({ type: 'SET_DISCIPLINE', discipline: group.discipline })}
              >
                <div className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate">
                    {group.discipline.charAt(0).toUpperCase() + group.discipline.slice(1)}
                  </span>
                </div>
                <span className="text-[9px] text-muted-foreground tabular-nums">{group.layers.length} layers</span>
              </button>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* Layers */}
      <ScrollArea className="flex-1 p-2">
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Layers {activeDiscipline ? `(${activeDiscipline.charAt(0).toUpperCase() + activeDiscipline.slice(1)})` : ''}
        </div>

        <div className="mb-1">
          {currentGroupLayers.map(layer => {
            const key = `${layer.discipline}/${layer.tableName}`;
            const style = LAYER_STYLES[layer.tableName];
            const isVisible = visibleLayers.has(key);
            return (
              <button
                key={key}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 pl-6 text-[11px] transition-all hover:bg-accent',
                  'border-none cursor-pointer text-left',
                  isVisible ? 'text-muted-foreground' : 'text-muted-foreground opacity-35'
                )}
                onClick={() => dispatch({ type: 'TOGGLE_LAYER', key })}
              >
                <span className="size-1.5 shrink-0 rounded-sm" style={{ background: style?.color || '#888' }} />
                <span className="w-4.5 shrink-0 text-center"><Icon name={layer.tableName} width={16} height={16} /></span>
                <span className="flex-1">{style?.displayName || layer.tableName}</span>
                <span className="text-[9px] text-muted-foreground tabular-nums">{layer.csvRows.size}</span>
                <span className={isVisible ? 'text-[var(--color-accent)]' : 'text-muted-foreground'}>
                  <Icon name={isVisible ? 'eye-visible' : 'eye-hidden'} width={18} height={18} />
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      {/* Add Level Dialog */}
      <AddLevelDialog
        open={showAddLevel}
        onClose={() => setShowAddLevel(false)}
        onConfirm={(name, elevation) => {
          const existingIds = new Set(levels.map(l => l.id));
          let n = 1;
          while (existingIds.has(`lv-${n}`)) n++;
          const id = `lv-${n}`;
          dispatch({
            type: 'ADD_LEVEL',
            level: { id, number: String(n), name, elevation },
          });
        }}
        defaultName={(() => {
          let n = 1;
          const existingNames = new Set(levels.map(l => l.name));
          while (existingNames.has(`Level ${n}`)) n++;
          return `Level ${n}`;
        })()}
        defaultElevation={levels.length > 0 ? Math.max(...levels.map(l => l.elevation)) + 3 : 0}
      />

      {/* Rename Level Dialog (reuse AddLevelDialog) */}
      {renameTarget && (
        <AddLevelDialog
          open={true}
          onClose={() => setRenameTarget(null)}
          onConfirm={(name, elevation) => {
            dispatch({ type: 'RENAME_LEVEL', levelId: renameTarget.id, name, elevation });
            setRenameTarget(null);
          }}
          defaultName={renameTarget.name}
          defaultElevation={renameTarget.elevation}
          title="Rename Level"
          confirmLabel="Save"
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <LevelContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          level={contextMenu.level}
          onRename={() => setRenameTarget(contextMenu.level)}
          onDelete={() => dispatch({ type: 'REMOVE_LEVEL', levelId: contextMenu.level.id })}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
