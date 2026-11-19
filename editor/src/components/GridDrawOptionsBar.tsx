import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState } from '../state/EditorContext.tsx';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Separator } from './ui/separator';
import { Icon } from './Icons.tsx';
import {
  getGridDrawOptions, nextGridLabel, setGridDrawOptions, subscribeGridDrawOptions, type GridLabelScheme,
} from '../tools/drawGridTool.ts';

const fieldClass = 'h-7 rounded-lg border-input bg-transparent px-2 text-[11px] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Options bar of the grid tool: label sequence (by direction, numbers, letters) and the next label. */
export default function GridDrawOptionsBar() {
  const { t } = useTranslation();
  const state = useEditorState();
  const o = useSyncExternalStore(subscribeGridDrawOptions, getGridDrawOptions, getGridDrawOptions);
  const names = state.grids.map(g => g.number);
  const preview = o.scheme === 'auto'
    ? `${nextGridLabel(names, 'numbers')} / ${nextGridLabel(names, 'letters')}`
    : nextGridLabel(names, o.scheme);
  const schemes: { value: GridLabelScheme; label: string }[] = [
    { value: 'auto', label: t('gridTool.scheme.auto') },
    { value: 'numbers', label: t('gridTool.scheme.numbers') },
    { value: 'letters', label: t('gridTool.scheme.letters') },
  ];
  const directions = [
    { value: 'vertical', label: t('gridTool.numbersOn.vertical') },
    { value: 'horizontal', label: t('gridTool.numbersOn.horizontal') },
  ];
  return (
    <div data-testid="grid-options"
      className="absolute bottom-[80px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap glass-panel rounded-[10px] border border-border px-3 py-[5px] shadow-[var(--shadow-panel)]">
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[#ef476f] select-none">
        <Icon name="grid" width={20} height={20} /> {t('display.Grids')}
      </span>
      <Separator orientation="vertical" className="h-4" />
      <label className="text-[10px] text-muted-foreground">{t('gridTool.labels')}</label>
      <Select value={o.scheme} onValueChange={v => { if (v) setGridDrawOptions({ scheme: v as GridLabelScheme }); }}>
        <SelectTrigger size="sm" className={`${fieldClass} min-w-28 gap-1`} data-testid="grid-scheme">
          <span>{schemes.find(s => s.value === o.scheme)?.label}</span>
        </SelectTrigger>
        <SelectContent>{schemes.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
      </Select>
      {o.scheme === 'auto' && (
        <>
          <label className="text-[10px] text-muted-foreground">{t('gridTool.numbersOn')}</label>
          <Select value={o.numbersOn} onValueChange={v => { if (v) setGridDrawOptions({ numbersOn: v as 'vertical' | 'horizontal' }); }}>
            <SelectTrigger size="sm" className={`${fieldClass} min-w-20 gap-1`} data-testid="grid-numbers-on">
              <span>{directions.find(d => d.value === o.numbersOn)?.label}</span>
            </SelectTrigger>
            <SelectContent>{directions.map(d => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
          </Select>
        </>
      )}
      <label className="text-[10px] text-muted-foreground">{t('gridTool.next')}</label>
      <Input className={`${fieldClass} w-20`} value={o.next} placeholder={preview} data-testid="grid-next"
        onChange={e => setGridDrawOptions({ next: e.target.value })} />
    </div>
  );
}
