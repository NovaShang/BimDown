import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Level, CsvRow } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { useEditorDispatch } from '../state/EditorContext.tsx';
import { getPropertyFields, PROPERTY_GROUPS, type PropertyField } from '../model/propertyFields.ts';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Button } from './ui/button';
import { Icon } from './Icons.tsx';
import { LevelSelect } from './LevelSelect.tsx';
import { NumberInput } from './NumberInput.tsx';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';

interface RightPanelProps {
  selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>;
  levels: Level[];
  offsetRight?: number;
}

export default function RightPanel({ selectedData, levels, offsetRight: _ }: RightPanelProps) {
  if (selectedData.size === 0) return null;

  return (
    <div
      className="absolute top-16 bottom-[52px] z-30 w-52 animate-in fade-in slide-in-from-left-2 duration-200"
      style={{ left: 12 + 208 + 8 }}
    >
      <div className="glass-panel flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
        <PropertiesContent selectedData={selectedData} levels={levels} />
      </div>
    </div>
  );
}

// ─── Properties Content ──────────────────────────────────────────────────────

function PropertiesContent({ selectedData, levels }: { selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>; levels: Level[] }) {
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
      <div className="relative shrink-0 border-b border-border/50 px-3 pb-2 pt-2.5">
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

      {/* Mesh fallback indicator */}
      {csv.mesh_file && (
        <div className="mx-3 my-1.5 flex shrink-0 items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1">
          <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('prop.meshFallback')}</span>
          <span className="ml-auto max-w-[120px] truncate text-[9px] text-muted-foreground" title={csv.mesh_file}>{csv.mesh_file}</span>
        </div>
      )}

      {/* Property groups */}
      <ScrollArea className="min-h-0 flex-1">
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

// ─── Property Row ────────────────────────────────────────────────────────────

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
        {(f.key === 'top_level_id' || f.key === 'level_id') ? (
          <LevelSelect
            value={value}
            onValueChange={(v) => onChange(f.key, v)}
            triggerClassName="h-[22px] min-w-0 flex-1 gap-0.5 rounded border-transparent bg-[var(--bg-input)] px-1.5 text-right text-[11px] tabular-nums hover:border-border focus-visible:border-[var(--color-accent)]"
          />
        ) : f.type === 'readonly' || !editable ? (
          <span className="truncate text-right text-[11px] tabular-nums text-foreground/70">{value}</span>
        ) : f.type === 'select' && f.options ? (
          <Select value={value} onValueChange={(v) => { if (v) onChange(f.key, v); }}>
            <SelectTrigger className="h-[22px] min-w-0 flex-1 gap-0.5 rounded border-transparent bg-[var(--bg-input)] px-1.5 text-right text-[11px] tabular-nums hover:border-border focus-visible:border-[var(--color-accent)]">
              <span className="truncate">{(() => { const o = f.options!.find(o => o.value === value); return o ? t(`option.${o.label}`, o.label) : value; })()}</span>
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
            <NumberInput
              className="h-[22px] min-w-0 flex-1 rounded border-transparent bg-transparent px-1.5 text-right text-[11px] hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]"
              value={value}
              onChange={v => onChange(f.key, v)}
              step={f.step}
              min={f.min}
              max={f.max}
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
