/**
 * Size field for MEP runs (duct width / height / diameter, pipe DN, conduit,
 * cable tray): shows mm (DN / de for pipes, inches in imperial projects),
 * accepts "65", "DN65", "de110", "Ø250", "1-1/2\"", and offers the standard
 * series in a pick list. The stored value stays in project units.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select';
import type { ProjectUnit } from '../types.ts';
import { formatMepSize, parseSizeText, sizeDisplayUnit, sizeFromDisplay, sizeOptions, sizeToDisplay, toMetres, type SizeKey } from './sizes.ts';
import { cn } from '../lib/utils.ts';

/** MEP line tables whose size_x / size_y use this field. */
export const MEP_SIZE_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

export function isMepSizeField(table: string | undefined, key: string): key is SizeKey {
  return !!table && MEP_SIZE_TABLES.has(table) && (key === 'size_x' || key === 'size_y');
}

/** Text shown in the field for a stored value. */
export function sizeFieldText(table: string, key: SizeKey, attrs: Record<string, string>, value: string, unit: ProjectUnit): string {
  const v = parseFloat(value);
  if (!(v > 0)) return value;
  const shape = attrs.shape || (table === 'duct' || table === 'cable_tray' ? 'rect' : 'round');
  if (table === 'pipe' && key === 'size_x') return formatMepSize('pipe', 'round', toMetres(v, unit), 0, { material: attrs.material, unit });
  if (shape === 'round' && key === 'size_x' && table === 'duct') return `Ø${sizeToDisplay(v, unit)}`;
  return String(sizeToDisplay(v, unit));
}

export function MepSizeInput({ table, sizeKey, attrs, value, onChange, unit, className, placeholder }: {
  table: string;
  sizeKey: SizeKey;
  /** The row (or drawing attrs): shape and material pick the series. */
  attrs: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
  unit: ProjectUnit;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const shown = sizeFieldText(table, sizeKey, attrs, value, unit);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(shown); }, [shown, editing]);
  const shape = attrs.shape || (table === 'duct' || table === 'cable_tray' ? 'rect' : 'round');
  const options = sizeOptions(table, sizeKey, shape, attrs.material, unit);
  const commit = () => {
    setEditing(false);
    const d = parseSizeText(text, unit);
    if (d === null) { setText(shown); return; }
    const v = String(sizeFromDisplay(d, unit));
    if (v !== value) onChange(v);
  };
  const suffix = table === 'pipe' && sizeKey === 'size_x' ? '' : sizeDisplayUnit(unit);
  const current = parseFloat(value);
  const selected = options.find(o => Math.abs(o.value - current) <= Math.max(1e-6, Math.abs(current) * 1e-3));
  return (
    <div className="flex items-center gap-0.5" data-testid={`mep-size-${sizeKey}`}>
      <Input
        className={cn(className, 'text-right')}
        type="text"
        value={text}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { setText(shown); setEditing(false); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
        title={t('mep.size.tip')}
      />
      {suffix && <span className="select-none text-[9px] text-muted-foreground">{suffix}</span>}
      <Select value={selected ? String(selected.value) : ''} onValueChange={v => { if (v) onChange(String(v)); }}>
        <SelectTrigger size="sm" className="h-6 w-5 justify-center border-none bg-transparent px-0 [&_svg]:size-3" aria-label={t('mep.size.pick')} title={t('mep.size.pick')}>
          <span className="sr-only">{t('mep.size.pick')}</span>
        </SelectTrigger>
        <SelectContent>
          {options.map(o => (
            <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
