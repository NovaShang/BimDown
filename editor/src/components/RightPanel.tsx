import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Level, CsvRow } from '../types.ts';
import { LAYER_STYLES } from '../types.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { getElementModule } from '../elements/registry.ts';
import { PROPERTY_GROUPS, type PropertyField } from '../elements/_propertyFields.ts';
import { systemFitsTable } from '../model/mepTopology.ts';
import { getProjectUnits, getUnitSuffix } from '../utils/units.ts';
import type { ProjectUnit } from '../types.ts';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Button } from './ui/button';
import { Icon } from './Icons.tsx';
import { ChevronRight, Pencil, RotateCcw } from 'lucide-react';
import { LevelSelect } from './LevelSelect.tsx';
import { NumberInput } from './NumberInput.tsx';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';
import LineLengthRow from './LineLengthRow.tsx';
import { TypeSelect } from './TypeSelect.tsx';
import EditTypeDialog from './EditTypeDialog.tsx';
import { findType, isTypedTable, typeParamState, typeValues } from '../model/types/catalog.ts';
import QuantitiesSection from './QuantitiesSection.tsx';

// Shared input styling so number / text / select / level controls read as one
// system: transparent until interaction, soft fill on hover, accent border on
// focus. Keeps the panel calm at rest instead of a grid of grey boxes.
const FIELD_INPUT =
  'h-[22px] min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-right text-[11px] tabular-nums transition-colors hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]';
const FIELD_SELECT = `${FIELD_INPUT} gap-0.5`;

interface RightPanelProps {
  selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>;
  levels: Level[];
  offsetRight?: number;
  readonly?: boolean;
}

export default function RightPanel({ selectedData, levels, offsetRight: _, readonly }: RightPanelProps) {
  if (selectedData.size === 0) return null;

  return (
    <div
      className="absolute top-16 bottom-[52px] z-30 flex w-52 flex-col animate-in fade-in slide-in-from-left-2 duration-200"
      style={{ left: 12 + 208 + 8 }}
    >
      <div className="glass-panel flex min-h-0 max-h-full shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
        <PropertiesContent selectedData={selectedData} levels={levels} readonly={readonly} />
      </div>
    </div>
  );
}

// ─── Properties Content ──────────────────────────────────────────────────────

function PropertiesContent({ selectedData, levels, readonly }: { selectedData: Map<string, { tableName: string; discipline: string; csv: CsvRow }>; levels: Level[]; readonly?: boolean }) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const projectUnit = getProjectUnits(state);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [typeDialogOpen, setTypeDialogOpen] = useState(false);

  const [firstId, firstData] = selectedData.entries().next().value!;
  const isSingleSelection = selectedData.size === 1;
  const tables = new Set([...selectedData.values()].map(d => d.tableName));
  const mixedTables = tables.size > 1;
  const style = mixedTables ? undefined : LAYER_STYLES[firstData.tableName];
  // Multi-selection: a field shows its value when every element agrees,
  // otherwise blank ("Mixed"); editing sets it on all of them (one undo step).
  const csv: CsvRow = isSingleSelection ? firstData.csv : commonValues([...selectedData.values()].map(d => d.csv));
  // Only elements of the open level's document can be edited.
  const editableSelection = [...selectedData.keys()].every(sid => state.document?.elements.has(sid.slice(sid.indexOf(':') + 1)));

  const handleChange = (key: string, value: string) => {
    if (isSingleSelection) dispatch({ type: 'UPDATE_ATTRS', id: firstId, attrs: { [key]: value } });
    else dispatch({ type: 'UPDATE_ATTRS_MANY', ids: [...selectedData.keys()], attrs: { [key]: value } });
  };

  // Element type (Revit "Type: …"): shown when every selected element is of
  // one typed table; switching applies to the whole selection.
  const types = state.project?.types;
  const sameTable = [...selectedData.values()].every(d => d.tableName === firstData.tableName);
  const showType = sameTable && isTypedTable(firstData.tableName) && !!getElementModule(firstData.tableName);
  const selectedTypeIds = new Set([...selectedData.values()].map(d => d.csv.type_id ?? ''));
  const typeId = selectedTypeIds.size === 1 ? [...selectedTypeIds][0] : '';
  const elementType = findType(types, typeId);

  const fields = (() => {
    const mod = getElementModule(firstData.tableName);
    if (!mod) return [];
    // Mixed tables: only the fields every selected type has.
    const shared = (key: string) => [...tables].every(tb => getElementModule(tb)?.propertyFields.some(f => f.key === key));
    const levelOptions = levels.map(l => ({ value: l.id, label: l.name || l.id }));
    // Inject dynamic options at render time. Level + MEP system definitions
    // live in project state, not in the static element module. For MEP line
    // tables (duct / pipe / etc.) filter to the disciplines that make sense
    // for that table. When no matching systems exist we leave the field as a
    // plain text input rather than showing an empty dropdown.
    const systemOptions = (state.project?.mepSystems ?? [])
      .filter(s => [...tables].every(tb => systemFitsTable(s, tb)))
      .map(s => ({ value: s.system_type, label: s.name || s.system_type }));
    return mod.propertyFields.filter(f => !mixedTables || shared(f.key)).map(f => {
      if (f.key === 'top_level_id') return { ...f, options: levelOptions };
      if (f.key === 'system_type' && systemOptions.length > 0) return { ...f, options: systemOptions };
      return f;
    });
  })();

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
        <div className="flex items-center gap-2 pr-6">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md"
            style={{
              color: style?.color,
              backgroundColor: style?.color ? `color-mix(in srgb, ${style.color} 14%, transparent)` : undefined,
            }}
          >
            <Icon name={mixedTables ? 'default' : firstData.tableName} width={15} height={15} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight">
            {mixedTables ? t('prop.multipleTypes') : style ? t(`display.${style.displayName}`) : firstData.tableName}
          </span>
          {isSingleSelection && (
            <span className="shrink-0 rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[9px] text-muted-foreground tabular-nums">{firstId}</span>
          )}
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
          <div className="mt-1 text-[10px] text-muted-foreground">{t('prop.elementsSelected', { count: selectedData.size })}</div>
        )}
      </div>

      {showType && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-3 py-1.5" data-testid="prop-type-row">
          <span className="w-[34px] shrink-0 text-[10px] text-muted-foreground">{t('type.label')}</span>
          <TypeSelect
            instanceTable={firstData.tableName}
            value={typeId}
            mixed={selectedTypeIds.size > 1}
            onChange={id => dispatch({ type: 'SET_ELEMENT_TYPE', ids: [...selectedData.keys()], typeId: id })}
            triggerClassName={cn(FIELD_SELECT, 'text-left')}
            disabled={readonly}
          />
          {!readonly && (
            <Button variant="ghost" size="icon-xs" className="size-5 shrink-0 text-muted-foreground"
              title={t('type.edit')} aria-label={t('type.edit')} data-testid="edit-type"
              onClick={() => setTypeDialogOpen(true)}>
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
      )}
      {showType && (
        <EditTypeDialog
          open={typeDialogOpen}
          instanceTable={firstData.tableName}
          typeId={typeId}
          onClose={() => setTypeDialogOpen(false)}
        />
      )}

      {/* Mesh fallback indicator */}
      {csv.mesh_file && (
        <div className="mx-3 my-1.5 flex shrink-0 items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1">
          <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('prop.meshFallback')}</span>
          <span className="ml-auto max-w-[120px] truncate text-[9px] text-muted-foreground" title={csv.mesh_file}>{csv.mesh_file}</span>
        </div>
      )}

      {/* Property groups */}
      <ScrollArea className="min-h-0 flex-1">
        {isSingleSelection && <LineLengthRow id={firstId} editable={!readonly} inputClass={FIELD_INPUT} />}
        <div className="py-0.5">
          {grouped.map((group, gi) => {
            const isCollapsed = collapsed.has(group.labelKey);
            return (
              <Collapsible key={group.labelKey} open={!isCollapsed} onOpenChange={() => toggleGroup(group.labelKey)}>
                <CollapsibleTrigger className={cn(
                  'flex w-full cursor-pointer items-center border-none bg-foreground/[0.05] px-3 py-1.5 text-left text-[10px] font-semibold text-foreground/65 transition-colors hover:bg-foreground/[0.08] hover:text-foreground',
                  gi > 0 && 'mt-1',
                )}>
                  <span>{t(group.labelKey)}</span>
                  <ChevronRight className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform', !isCollapsed && 'rotate-90')} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-3 pb-1.5 pt-1">
                    {group.fields.map(f => (
                      <PropertyRow
                        key={f.key}
                        field={f}
                        value={csv[f.key] ?? ''}
                        editable={!readonly && editableSelection && f.type !== 'readonly'}
                        mixed={!isSingleSelection && csv[f.key] === undefined && [...selectedData.values()].some(d => (d.csv[f.key] ?? '') !== '')}
                        typeState={isSingleSelection ? typeParamState(firstData.tableName, csv, f.key, types) : null}
                        onResetToType={elementType ? () => handleChange(f.key, typeValues(elementType)[f.key] ?? '') : undefined}
                        onChange={handleChange}
                        projectUnit={projectUnit}
                        t={(key: string, fallback?: string) => t(key, { defaultValue: fallback }) as string}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {isSingleSelection && <QuantitiesSection selectionId={firstId} />}
        </div>
      </ScrollArea>
    </>
  );
}

/** Values shared by every row; keys where the rows differ are left out. */
function commonValues(rows: CsvRow[]): CsvRow {
  const out: CsvRow = {};
  const keys = new Set(rows.flatMap(r => Object.keys(r)));
  for (const k of keys) {
    const v = rows[0][k] ?? '';
    if (rows.every(r => (r[k] ?? '') === v)) out[k] = v;
  }
  return out;
}

// ─── Property Row ────────────────────────────────────────────────────────────

function PropertyRow({
  field: f,
  value,
  editable,
  mixed,
  typeState,
  onResetToType,
  onChange,
  projectUnit,
  t,
}: {
  field: PropertyField;
  value: string;
  editable: boolean;
  /** Multi-selection whose elements disagree on this field. */
  mixed?: boolean;
  /** 'type' = value comes from the element's type; 'override' = the element overrides it. */
  typeState?: 'type' | 'override' | null;
  onResetToType?: () => void;
  onChange: (key: string, value: string) => void;
  projectUnit: ProjectUnit;
  t: (key: string, fallback?: string) => string;
}) {
  const label = t(`field.${f.label}`, f.label);
  // Length fields are tagged with `unit: 'm'` in the registry; substitute the
  // project's declared unit at render time. Non-length units (°, etc.) pass
  // through unchanged. Underlying CSV values are NOT converted — they're
  // interpreted as the project unit per BimDown's store-as-displayed model.
  const renderedUnit = f.unit === 'm' ? getUnitSuffix(projectUnit).trim() : f.unit;
  const mixedLabel = t('prop.mixed', 'Mixed');

  return (
    <div className="-mx-1 flex items-center gap-2 rounded-md px-1 py-[3px] transition-colors hover:bg-foreground/[0.03]">
      <span className="flex w-[72px] shrink-0 items-center gap-0.5 truncate text-[10px] text-muted-foreground" title={label}>
        <span className="truncate">{label}</span>
        {typeState === 'type' && (
          <span className="size-1 shrink-0 rounded-full bg-[var(--color-accent)]/60" title={t('type.fromType')} data-testid={`from-type-${f.key}`} />
        )}
        {typeState === 'override' && (
          editable && onResetToType ? (
            <button type="button" className="inline-flex shrink-0 cursor-pointer border-none bg-transparent p-0 text-amber-600 hover:text-foreground"
              title={t('type.override')} aria-label={t('type.override')} onClick={onResetToType} data-testid={`reset-type-${f.key}`}>
              <RotateCcw className="size-2.5" />
            </button>
          ) : (
            <span className="size-1 shrink-0 rounded-full bg-amber-500" title={t('type.override')} />
          )
        )}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {(f.key === 'top_level_id' || f.key === 'level_id') ? (
          <LevelSelect
            value={value}
            onValueChange={(v) => onChange(f.key, v)}
            triggerClassName={FIELD_SELECT}
          />
        ) : f.type === 'readonly' || !editable ? (
          <span className="truncate px-1.5 text-right text-[11px] tabular-nums text-foreground/70">
            {value !== '' ? value : <span className="text-muted-foreground/40">{mixed ? mixedLabel : <>&mdash;</>}</span>}
          </span>
        ) : f.type === 'select' && f.options ? (
          <Select value={value} onValueChange={(v) => { if (v) onChange(f.key, v); }}>
            <SelectTrigger className={FIELD_SELECT}>
              <span className="truncate">{(() => {
                if (mixed) return <span className="text-muted-foreground/60">{mixedLabel}</span>;
                const o = f.options!.find(o => o.value === value);
                // system_type labels are user-defined project names, not i18n keys.
                const labelOf = (lbl: string) => f.key === 'system_type' ? lbl : t(`option.${lbl}`, lbl);
                return o ? labelOf(o.label) : value;
              })()}</span>
            </SelectTrigger>
            <SelectContent>
              {!f.options.some(o => o.value === value) && value && (
                <SelectItem value={value}>{value}</SelectItem>
              )}
              {f.options.map(o => (
                <SelectItem key={o.value} value={o.value}>{f.key === 'system_type' ? o.label : t(`option.${o.label}`, o.label)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : f.type === 'number' ? (
          <>
            <NumberInput
              className={FIELD_INPUT}
              value={value}
              onChange={v => onChange(f.key, v)}
              placeholder={mixed ? mixedLabel : undefined}
              step={f.step}
              min={f.min}
              max={f.max}
              parseImperial={f.unit === 'm' && (projectUnit === 'ft' || projectUnit === 'in') ? projectUnit : undefined}
            />
            <span className="w-3 shrink-0 select-none text-left text-[9px] text-muted-foreground/60">{renderedUnit ?? ''}</span>
          </>
        ) : (
          <Input
            className={FIELD_INPUT}
            type="text"
            value={value}
            placeholder={mixed ? mixedLabel : undefined}
            onChange={e => onChange(f.key, e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
