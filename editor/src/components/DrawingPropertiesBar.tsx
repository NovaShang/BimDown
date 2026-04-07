import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { getDrawingFields } from '../model/drawingSchema.ts';
import { LAYER_STYLES, DISCIPLINE_COLORS } from '../types.ts';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Icon } from './Icons.tsx';
import { LevelSelect } from './LevelSelect.tsx';
import { NumberInput } from './NumberInput.tsx';

const fieldInputClass = 'h-7 rounded-lg border-input bg-transparent px-2 text-[11px] tabular-nums focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function DrawingPropertiesBar() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();

  const target = state.drawingTarget;
  if (!target) return null;

  const levels = state.project?.levels ?? [];
  const fields = getDrawingFields(target.tableName, levels);
  if (fields.length === 0) return null;

  const style = LAYER_STYLES[target.tableName];
  const disciplineColor = DISCIPLINE_COLORS[target.discipline] || '#888';
  const attrs = state.drawingAttrs;

  const handleChange = (key: string, value: string) => {
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...attrs, [key]: value } });
  };

  return (
    <div
      className="absolute bottom-[80px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap glass-panel rounded-[10px] border border-border px-3 py-[5px] shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-1.5 duration-200"
      style={{ '--dp-color': disciplineColor } as React.CSSProperties}
    >
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold select-none" style={{ color: disciplineColor }}>
        <Icon name={target.tableName} width={20} height={20} /> {style ? t(`display.${style.displayName}`) : target.tableName}
      </span>
      <Separator orientation="vertical" className="h-4" />
      {fields.map(f => (
        <div key={f.key} className="flex items-center gap-1.5">
          <label className="text-[10px] text-muted-foreground">{t(`field.${f.label}`, f.label)}</label>
          {f.key === 'top_level_id' ? (
            <LevelSelect
              value={attrs[f.key] ?? ''}
              onValueChange={(v) => handleChange(f.key, v)}
              size="sm"
              triggerClassName={`${fieldInputClass} min-w-16 gap-1`}
            />
          ) : f.type === 'select' && f.options ? (
            <Select
              value={attrs[f.key] ?? ''}
              onValueChange={(v) => { if (v) handleChange(f.key, v); }}
            >
              <SelectTrigger size="sm" className={`${fieldInputClass} min-w-16 gap-1`}>
                <span className="truncate">{(() => { const o = f.options!.find(o => o.value === (attrs[f.key] ?? '')); return o ? t(`option.${o.label}`, o.label) : attrs[f.key] ?? ''; })()}</span>
              </SelectTrigger>
              <SelectContent>
                {f.options.map(o => (
                  <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`, o.label)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : f.type === 'number' ? (
            <div className="flex items-center gap-1">
              <NumberInput
                className={`${fieldInputClass} w-[60px] text-right`}
                value={attrs[f.key] ?? ''}
                onChange={v => handleChange(f.key, v)}
                step={f.step}
                min={f.min}
                max={f.max}
              />
              {f.unit && <span className="text-[9px] text-muted-foreground select-none">{f.unit}</span>}
            </div>
          ) : (
            <Input
              className={`${fieldInputClass} w-20`}
              type="text"
              value={attrs[f.key] ?? ''}
              placeholder={f.label}
              onChange={e => handleChange(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
      <Separator orientation="vertical" className="h-4" />
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-[22px] text-muted-foreground"
        onClick={() => {
          dispatch({ type: 'SET_TOOL', tool: 'select' });
          dispatch({ type: 'SET_DRAWING_TARGET', target: null });
          dispatch({ type: 'SET_DRAWING_STATE', state: null });
        }}
        title="Cancel (Esc)"
      >
        &#x2715;
      </Button>
    </div>
  );
}
