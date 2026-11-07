import { useTranslation } from 'react-i18next';
import { useEditorState } from '../state/EditorContext.tsx';
import { findType, typesForInstanceTable } from '../model/types/catalog.ts';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';

/** Select value standing for "no type" (base-ui selects need a non-empty value). */
const NO_TYPE = '__none__';

interface TypeSelectProps {
  instanceTable: string;
  /** Current type id ('' = none). */
  value: string;
  onChange: (typeId: string) => void;
  triggerClassName?: string;
  size?: 'sm' | 'default';
  disabled?: boolean;
  /** Several elements with different types are selected. */
  mixed?: boolean;
}

/** Revit-style type picker ("Type: Basic Wall 200"): the types that fit `instanceTable`, plus "No type". */
export function TypeSelect({ instanceTable, value, onChange, triggerClassName, size, disabled, mixed }: TypeSelectProps) {
  const { t } = useTranslation();
  const types = useEditorState().project?.types;
  const options = typesForInstanceTable(types, instanceTable);
  const current = findType(types, value);
  const label = mixed ? t('type.varies') : value ? (current?.name ?? value) : t('type.none');
  return (
    <Select value={mixed ? '' : value || NO_TYPE} onValueChange={v => { if (v) onChange(v === NO_TYPE ? '' : v); }} disabled={disabled}>
      <SelectTrigger size={size} className={triggerClassName} data-testid="type-select" title={label}>
        <span className="truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_TYPE}><span className="text-muted-foreground">{t('type.none')}</span></SelectItem>
        {value && !current && <SelectItem value={value}>{value}</SelectItem>}
        {options.map(o => (
          <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
