import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Level, CsvRow } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { TABLE_REGISTRY } from '../model/tableRegistry.ts';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { PROPERTY_FIELD_DEFS } from '../model/propertyFields.ts';
import type { LayerGroup } from '../state/editorTypes.ts';
import { ScrollArea } from './ui/scroll-area';
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
  x, y, onRename, onDelete, onClose,
}: {
  x: number; y: number;
  onRename: () => void; onDelete: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
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
        {t('panel.rename')}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-red-400 hover:bg-accent"
        onClick={() => { onDelete(); onClose(); }}
      >
        {t('panel.delete')}
      </button>
    </div>
  );
}



// ─── Element List (expandable per layer) ─────────────────────────────────────

/** Fields not useful in the compact element list */
const SKIP_FIELDS = new Set([
  'number', 'base_offset', 'top_level_id', 'top_offset', 'host_id',
  'x', 'y', 'position', 'start_z', 'end_z', 'start_node_id', 'end_node_id',
]);

interface ColumnDef {
  key: string;
  label: string;
  unit?: string;
}

function getColumns(tableName: string): ColumnDef[] {
  const def = TABLE_REGISTRY[tableName];
  if (!def) return [];
  return def.csvHeaders
    .filter(h => !SKIP_FIELDS.has(h))
    .slice(0, 2)
    .map(h => {
      const pf = PROPERTY_FIELD_DEFS[h];
      return {
        key: h,
        label: pf?.label ?? h.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        unit: pf?.unit,
      };
    });
}

function formatCellValue(val: string | undefined, unit?: string): string {
  if (!val) return '–';
  if (unit && !isNaN(Number(val))) return `${val}${unit}`;
  return val;
}

function ElementList({ tableName, csvRows, selectedIds, onSelect }: {
  tableName: string;
  csvRows: Map<string, CsvRow>;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  const columns = getColumns(tableName);

  return (
    <div className="mb-0.5 py-0.5 pl-7">
      {Array.from(csvRows.entries()).map(([id, row]) => {
        const isSelected = selectedIds.has(id);
        return (
          <button
            key={id}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-[10px] transition-colors',
              'border-none cursor-pointer text-left',
              isSelected
                ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => onSelect(id)}
          >
            <span className="shrink-0 tabular-nums font-medium">{row.number || id}</span>
            <span className="flex-1 truncate text-muted-foreground/60 tabular-nums">
              {columns.map(col => formatCellValue(row[col.key], col.unit)).join(' · ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Main LeftPanel ──────────────────────────────────────────────────────────

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
}: LeftPanelProps) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const { activeDiscipline, selectedIds } = useEditorState();
  const [showAddLevel, setShowAddLevel] = useState(false);
  const [expandedLayer, setExpandedLayer] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; level: Level } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Level | null>(null);

  const currentGroup = layerGroups.find(g => g.discipline === activeDiscipline);
  const currentGroupLayers = currentGroup ? [...currentGroup.layers].sort((a, b) => {
    const oa = LAYER_STYLES[a.tableName]?.order ?? 99;
    const ob = LAYER_STYLES[b.tableName]?.order ?? 99;
    return oa - ob;
  }) : [];

  return (
    <div className="absolute left-3 top-16 bottom-[52px] z-30 flex w-52 flex-col gap-2 select-none">
      {/* Floor Switcher */}
      <div data-tour="floors" className="glass-panel flex shrink-0 max-h-[40%] flex-col rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
        <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 pt-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('panel.floors')}
          </span>
          <button
            className="flex size-4 cursor-pointer items-center justify-center rounded border-none bg-transparent text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setShowAddLevel(true)}
            title={t('panel.addLevel')}
          >
            +
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
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

      {/* Layers */}
      <div className="glass-panel flex min-h-0 flex-1 shrink flex-col overflow-hidden rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
        <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('panel.layers')}</span>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <div className="mb-1">
            {currentGroupLayers.map(layer => {
              const key = `${layer.discipline}/${layer.tableName}`;
              const style = LAYER_STYLES[layer.tableName];
              const isVisible = visibleLayers.has(key);
                const isExpanded = expandedLayer === key;
                return (
                  <div key={key}>
                    <button
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-all hover:bg-accent',
                        'border-none cursor-pointer text-left',
                        isVisible ? 'text-muted-foreground' : 'text-muted-foreground opacity-35',
                        isExpanded && 'bg-accent/50'
                      )}
                      onClick={() => setExpandedLayer(isExpanded ? null : key)}
                    >
                      <svg
                        width="10" height="10" viewBox="0 0 10 10"
                        className={cn('shrink-0 transition-transform duration-150', isExpanded && 'rotate-90')}
                      >
                        <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="w-4.5 shrink-0 text-center"><Icon name={layer.tableName} width={16} height={16} /></span>
                      <span className="flex-1">{style ? t(`display.${style.displayName}`) : layer.tableName}</span>
                      <span className="text-[9px] text-muted-foreground tabular-nums">{layer.csvRows.size}</span>
                      <span
                        className={cn('hover:opacity-100', isVisible ? 'text-[var(--color-accent)]' : 'text-muted-foreground')}
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_LAYER', key }); }}
                      >
                        <Icon name={isVisible ? 'eye-visible' : 'eye-hidden'} width={18} height={18} />
                      </span>
                    </button>
                    {isExpanded && layer.csvRows.size > 0 && (
                      <ElementList
                        tableName={layer.tableName}
                        csvRows={layer.csvRows}
                        selectedIds={selectedIds}
                        onSelect={(id) => dispatch({ type: 'SELECT', ids: [id] })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
        </ScrollArea>
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
          title={t('dialog.renameLevel')}
          confirmLabel={t('dialog.save')}
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
