import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CsvRow } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { BIM_MATERIAL_OPTIONS } from '../three/utils/bimMaterials.ts';
import { useEditorDispatch } from '../state/EditorContext.tsx';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { ScrollArea } from './ui/scroll-area';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Button } from './ui/button';
import { Icon } from './Icons.tsx';

interface FloatingPropertiesProps {
  selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>;
}

const PROPERTY_GROUP_KEYS: { labelKey: string; keys: string[] }[] = [
  { labelKey: 'prop.Identity', keys: ['id', 'number', 'name'] },
  { labelKey: 'prop.Geometry', keys: ['base_offset', 'top_offset', 'height', 'width', 'thickness', 'size_x', 'size_y', 'shape', 'start_z', 'end_z', 'length', 'area'] },
  { labelKey: 'prop.Material', keys: ['material', 'function'] },
  { labelKey: 'prop.Relationships', keys: ['host_id', 'top_level_id', 'start_node_id', 'end_node_id'] },
  { labelKey: 'prop.System', keys: ['system_type', 'equipment_type', 'terminal_type', 'operation'] },
];

const READ_ONLY_KEYS = new Set(['id', 'length', 'area', 'location_param']);

const ENUM_OPTIONS: Record<string, string[]> = {
  material: BIM_MATERIAL_OPTIONS,
  operation: ['single_swing', 'double_swing', 'sliding', 'folding'],
  function: ['floor', 'roof', 'finish'],
  system_type: ['hvac', 'plumbing', 'electrical'],
  shape: ['rectangular', 'round'],
};

export default function FloatingProperties({ selectedData }: FloatingPropertiesProps) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (selectedData.size === 0) return null;

  const [firstId, firstData] = selectedData.entries().next().value!;
  const style = LAYER_STYLES[firstData.tableName];
  const csv = firstData.csv;
  const isSingleSelection = selectedData.size === 1;

  const handleChange = (key: string, value: string) => {
    if (!isSingleSelection) return;
    dispatch({ type: 'UPDATE_ATTRS', id: firstId, attrs: { [key]: value } });
  };

  // Group properties
  const grouped: { label: string; props: [string, string][] }[] = [];
  const usedKeys = new Set<string>();

  for (const group of PROPERTY_GROUP_KEYS) {
    const props: [string, string][] = [];
    for (const key of group.keys) {
      if (csv[key] !== undefined) {
        props.push([key, csv[key]]);
        usedKeys.add(key);
      }
    }
    if (props.length > 0) {
      grouped.push({ label: t(group.labelKey), props });
    }
  }

  const otherProps: [string, string][] = [];
  for (const [key, value] of Object.entries(csv)) {
    if (!usedKeys.has(key)) {
      otherProps.push([key, value]);
    }
  }
  if (otherProps.length > 0) {
    grouped.push({ label: t('prop.Other'), props: otherProps });
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
    <div className="absolute right-3 top-3 z-30 flex max-h-[calc(100%-80px)] w-[260px] flex-col overflow-hidden glass-panel rounded-lg border border-border shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-right-3 duration-200">
      {/* Header */}
      <div className="relative border-b border-border px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm" style={{ color: style?.color }}>
            <Icon name={firstData.tableName} width={20} height={20} />
          </span>
          <span className="text-xs font-semibold">{style ? t(`display.${style.displayName}`) : firstData.tableName}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{firstId}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 size-5 text-muted-foreground"
          onClick={() => dispatch({ type: 'CLEAR_SELECTION' })}
        >
          x
        </Button>
        {selectedData.size > 1 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">{t('prop.elementsSelected', { count: selectedData.size })}</div>
        )}
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {grouped.map(group => {
            const isCollapsed = collapsed.has(group.label);
            return (
              <Collapsible key={group.label} open={!isCollapsed} onOpenChange={() => toggleGroup(group.label)}>
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 border-none bg-transparent px-3 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground">
                  <span className="w-2.5 text-[8px]">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                  {group.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-3">
                    {group.props.map(([key, value]) => (
                      <div key={key} className="flex items-baseline justify-between gap-2 py-[3px]">
                        <span className="shrink-0 text-[11px] text-muted-foreground">{formatKey(key)}</span>
                        {READ_ONLY_KEYS.has(key) || !isSingleSelection ? (
                          <span className="truncate text-right text-[11px] tabular-nums">{value}</span>
                        ) : ENUM_OPTIONS[key] ? (
                          <Select
                            value={value}
                            onValueChange={(v) => { if (v) handleChange(key, v); }}
                          >
                            <SelectTrigger className="h-5 min-w-0 flex-1 gap-0.5 rounded-sm border-transparent bg-[var(--bg-input)] px-1 py-0.5 text-right text-[11px] tabular-nums focus-visible:border-[var(--color-accent)]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {!ENUM_OPTIONS[key].includes(value) && <SelectItem value={value}>{value}</SelectItem>}
                              {ENUM_OPTIONS[key].map(opt => (
                                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            className="h-5 min-w-0 flex-1 rounded-sm border-transparent bg-transparent px-1 py-0.5 text-right text-[11px] tabular-nums focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]"
                            type="text"
                            value={value}
                            onChange={e => handleChange(key, e.target.value)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function formatKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\bid\b/g, 'ID').replace(/\b\w/g, c => c.toUpperCase());
}
