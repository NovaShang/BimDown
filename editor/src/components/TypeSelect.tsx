import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { findType, typeTableFor, typesForInstanceTable } from '../model/types/catalog.ts';
import { withStarterTypes } from '../model/types/starter.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { typeLabel } from '../model/displayNames.ts';

/** Select value standing for "no type" (base-ui selects need a non-empty value). */
const NO_TYPE = '__none__';
const ADD_STARTER = '__add_starter__';

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
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const types = state.project?.types;
  const options = typesForInstanceTable(types, instanceTable);
  const current = findType(types, value);
  const label = mixed ? t('type.varies') : value ? (current ? typeLabel(t, current) : value) : t('type.none');
  // A project whose type files predate this category (e.g. no furniture_type.csv) can pull in the starter rows.
  const typeTable = typeTableFor(instanceTable)?.table;
  const starter = types && typeTable && options.length === 0 && !state.readonly
    ? withStarterTypes(types, typeTable, unitsPerMetreOf(getProjectUnits(state)))
    : null;
  const pick = (v: string) => {
    if (v === ADD_STARTER) {
      if (starter) dispatch({ type: 'UPDATE_TYPES', types: { types: starter.types, saved: true }, description: 'Add starter types' });
      return;
    }
    onChange(v === NO_TYPE ? '' : v);
  };
  return (
    <Select value={mixed ? '' : value || NO_TYPE} onValueChange={v => { if (v) pick(v); }} disabled={disabled}>
      <SelectTrigger size={size} className={triggerClassName} data-testid="type-select" title={label}>
        <span className="truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_TYPE}><span className="text-muted-foreground">{t('type.none')}</span></SelectItem>
        {value && !current && <SelectItem value={value}>{value}</SelectItem>}
        {options.map(o => (
          <SelectItem key={o.id} value={o.id}>{typeLabel(t, o)}</SelectItem>
        ))}
        {starter && (
          <SelectItem value={ADD_STARTER} data-testid="type-add-starter">
            <span className="text-[var(--color-accent)]">{t('type.addStarter')}</span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
