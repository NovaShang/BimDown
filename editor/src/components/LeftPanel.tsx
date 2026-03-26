import { useState, useEffect, useRef } from 'react';
import type { Level, CsvRow } from '../types.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { DISCIPLINES } from '../model/tableRegistry.ts';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { LayerGroup } from '../state/editorTypes.ts';
import { ScrollArea } from './ui/scroll-area';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Icon } from './Icons.tsx';
import { cn } from '../lib/utils';
import AddLevelDialog from './AddLevelDialog.tsx';

interface LeftPanelProps {
  levels: Level[];
  currentLevel: string;
  layerGroups: LayerGroup[];
  visibleLayers: Set<string>;
  selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>;
}

/** Inline context menu for level items */
function LevelContextMenu({
  x, y, onRename, onDelete, onClose,
}: {
  x: number; y: number;
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
      className="glass-panel fixed z-50 min-w-[120px] rounded-md border border-border py-1 shadow-xl"
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

const READ_ONLY_KEYS = new Set(['id', 'length', 'area', 'location_param']);

function InlineProperties({ selectedData }: { selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }> }) {
  const dispatch = useEditorDispatch();
  const [firstId, firstData] = selectedData.entries().next().value!;
  const style = LAYER_STYLES[firstData.tableName];
  const csv = firstData.csv;
  const isSingle = selectedData.size === 1;

  const handleChange = (key: string, value: string) => {
    if (!isSingle) return;
    dispatch({ type: 'UPDATE_ATTRS', id: firstId, attrs: { [key]: value } });
  };

  return (
    <ScrollArea className="h-full p-2">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5">
        <span style={{ color: style?.color }}>
          <Icon name={firstData.tableName} width={16} height={16} />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {isSingle ? (style?.displayName || firstData.tableName) : `${selectedData.size} selected`}
        </span>
      </div>
      {/* Properties */}
      <div className="flex flex-col gap-px">
        {Object.entries(csv).map(([key, value]) => (
          <div key={key} className="flex items-center gap-1 px-2 py-[3px]">
            <span className="w-[70px] shrink-0 truncate text-[10px] text-muted-foreground">{key}</span>
            {READ_ONLY_KEYS.has(key) || !isSingle ? (
              <span className="flex-1 truncate text-[10px] text-foreground">{value}</span>
            ) : (
              <input
                className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] text-foreground outline-none transition-colors hover:border-border focus:border-[var(--color-accent)] focus:bg-[var(--bg-input)]"
                defaultValue={value}
                onBlur={e => {
                  if (e.target.value !== value) handleChange(key, e.target.value);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function DisciplineSelect({ value, onChange }: { value: string | null; onChange: (d: string) => void }) {
  return (
    <Select value={value ?? DISCIPLINES[0]} onValueChange={(v) => { if (v) onChange(v) }}>
      <SelectTrigger className="h-5 min-w-0 gap-1 border-none bg-transparent px-1 py-0 text-[10px] shadow-none">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: value ? DISCIPLINE_COLORS[value] : '#888' }} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[130px]">
        {DISCIPLINES.map(d => (
          <SelectItem key={d} value={d} className="text-[11px]">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: DISCIPLINE_COLORS[d] }} />
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
  selectedData,
}: LeftPanelProps) {
  const dispatch = useEditorDispatch();
  const { activeDiscipline } = useEditorState();
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
    <div className="absolute left-3 top-16 bottom-3 z-30 flex w-52 flex-col gap-2 select-none">
      {/* Floor Switcher */}
      <div className="glass-panel shrink-0 overflow-y-auto rounded-2xl border border-[#2a2a2a] shadow-[0_4px_24px_rgba(0,0,0,0.4)] p-2">
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

      {/* Layers / Properties (switches when element selected) */}
      <div className="glass-panel max-h-[60%] overflow-hidden rounded-2xl border border-[#2a2a2a] shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
      {selectedData.size > 0 ? (
        <InlineProperties selectedData={selectedData} />
      ) : (
      <ScrollArea className="h-full p-2">
        <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Layers</span>
          <DisciplineSelect
            value={activeDiscipline}
            onChange={(d) => dispatch({ type: 'SET_DISCIPLINE', discipline: d })}
          />
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
      )}
      </div>

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
          onRename={() => setRenameTarget(contextMenu.level)}
          onDelete={() => dispatch({ type: 'REMOVE_LEVEL', levelId: contextMenu.level.id })}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
