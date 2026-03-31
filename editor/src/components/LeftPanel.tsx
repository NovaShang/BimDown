import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Level, CsvRow } from '../types.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { DISCIPLINES } from '../model/tableRegistry.ts';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getPropertyFields, PROPERTY_GROUPS, type PropertyField } from '../model/propertyFields.ts';
import type { LayerGroup } from '../state/editorTypes.ts';
import { ScrollArea } from './ui/scroll-area';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Button } from './ui/button';
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

// ─── Inline Properties Panel ─────────────────────────────────────────────────

function InlineProperties({ selectedData, levels }: { selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>; levels: Level[] }) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [firstId, firstData] = selectedData.entries().next().value!;
  const style = LAYER_STYLES[firstData.tableName];
  const csv = firstData.csv;
  const isSingleSelection = selectedData.size === 1;

  const handleChange = (key: string, value: string) => {
    if (!isSingleSelection) return;
    dispatch({ type: 'UPDATE_ATTRS', id: firstId, attrs: { [key]: value } });
  };

  const fields = getPropertyFields(firstData.tableName, levels);

  // Group fields
  const grouped: { labelKey: string; fields: PropertyField[] }[] = [];
  const fieldsByGroup = new Map<string, PropertyField[]>();
  for (const f of fields) {
    const list = fieldsByGroup.get(f.group) ?? [];
    list.push(f);
    fieldsByGroup.set(f.group, list);
  }
  for (const g of PROPERTY_GROUPS) {
    const gFields = fieldsByGroup.get(g.key);
    if (gFields && gFields.length > 0) {
      grouped.push({ labelKey: g.labelKey, fields: gFields });
    }
  }

  const toggleGroup = (label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <>
      {/* Header */}
      <div className="relative border-b border-border/50 px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-1.5">
          <span style={{ color: style?.color }}>
            <Icon name={firstData.tableName} width={16} height={16} />
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">
            {style ? t(`display.${style.displayName}`) : firstData.tableName}
          </span>
          <span className="ml-auto text-[9px] text-muted-foreground/50 tabular-nums">{firstId}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-1.5 top-1.5 size-5 text-muted-foreground"
          onClick={() => dispatch({ type: 'CLEAR_SELECTION' })}
        >
          &#x2715;
        </Button>
        {selectedData.size > 1 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">{t('prop.elementsSelected', { count: selectedData.size })}</div>
        )}
      </div>

      {/* Property groups */}
      <ScrollArea className="flex-1">
        <div className="py-0.5">
          {grouped.map((group, gi) => {
            const isCollapsed = collapsed.has(group.labelKey);
            return (
              <Collapsible key={group.labelKey} open={!isCollapsed} onOpenChange={() => toggleGroup(group.labelKey)}>
                <CollapsibleTrigger className={cn(
                  'flex w-full cursor-pointer items-center gap-1 border-none bg-transparent px-3 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70 hover:text-foreground',
                  gi > 0 && 'border-t border-border/30',
                )}>
                  <span className="w-2.5 text-[8px] text-muted-foreground/50">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                  {t(group.labelKey)}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-3 pb-1">
                    {group.fields.map(f => (
                      <PropertyRow
                        key={f.key}
                        field={f}
                        value={csv[f.key] ?? ''}
                        editable={isSingleSelection && f.type !== 'readonly'}
                        onChange={handleChange}
                        t={(key: string, fallback?: string) => t(key, { defaultValue: fallback }) as string}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}

function PropertyRow({
  field: f,
  value,
  editable,
  onChange,
  t,
}: {
  field: PropertyField;
  value: string;
  editable: boolean;
  onChange: (key: string, value: string) => void;
  t: (key: string, fallback?: string) => string;
}) {
  const label = t(`field.${f.label}`, f.label);

  return (
    <div className="flex items-center gap-2 py-[3px]">
      <span className="w-[72px] shrink-0 truncate text-[10px] text-muted-foreground" title={label}>
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {f.type === 'readonly' || !editable ? (
          <span className="truncate text-right text-[11px] tabular-nums text-foreground/70">{value}</span>
        ) : f.type === 'select' && f.options ? (
          <Select value={value} onValueChange={(v) => { if (v) onChange(f.key, v); }}>
            <SelectTrigger className="h-[22px] min-w-0 flex-1 gap-0.5 rounded border-transparent bg-[var(--bg-input)] px-1.5 text-right text-[11px] tabular-nums hover:border-border focus-visible:border-[var(--color-accent)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!f.options.some(o => o.value === value) && value && (
                <SelectItem value={value}>{value}</SelectItem>
              )}
              {f.options.map(o => (
                <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`, o.label)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : f.type === 'number' ? (
          <>
            <Input
              className="h-[22px] min-w-0 flex-1 rounded border-transparent bg-transparent px-1.5 text-right text-[11px] tabular-nums hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]"
              type="text"
              inputMode="decimal"
              value={value}
              onChange={e => {
                const v = e.target.value;
                if (v === '' || v === '-' || !isNaN(Number(v))) onChange(f.key, v);
              }}
            />
            {f.unit && <span className="shrink-0 text-[9px] text-muted-foreground/60 select-none">{f.unit}</span>}
          </>
        ) : (
          <Input
            className="h-[22px] min-w-0 flex-1 rounded border-transparent bg-transparent px-1.5 text-right text-[11px] hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]"
            type="text"
            value={value}
            onChange={e => onChange(f.key, e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Main LeftPanel ──────────────────────────────────────────────────────────

export default function LeftPanel({
  levels,
  currentLevel,
  layerGroups,
  visibleLayers,
  selectedData,
}: LeftPanelProps) {
  const { t } = useTranslation();
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

  const hasSelection = selectedData.size > 0;

  return (
    <div className="absolute left-3 top-16 bottom-[52px] z-30 flex w-52 flex-col gap-2 select-none">
      {/* Floor Switcher */}
      <div className="glass-panel shrink-0 max-h-[40%] overflow-y-auto rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)] p-2">
        <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
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

      {/* Layers / Properties — switches when element selected */}
      <div className="glass-panel flex min-h-0 shrink flex-col overflow-hidden rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
        {hasSelection ? (
          <InlineProperties selectedData={selectedData} levels={levels} />
        ) : (
          <ScrollArea className="h-full p-2">
            <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('panel.layers')}</span>
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
                    <span className="flex-1">{style ? t(`display.${style.displayName}`) : layer.tableName}</span>
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
