/**
 * Wall placement options in the drawing properties bar (Revit's Draw panel +
 * options bar): draw mode, chain, location line and offset. Values live in
 * reserved `__` drawingAttrs keys (never persisted, see wallDrawTool.ts).
 */
import { useTranslation } from 'react-i18next';
import { Slash, Square, Spline, MousePointerClick, Link } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { WALL_OPT, wallDrawOptions, withWallDrawOption, type WallDrawMode } from '../tools/wallDrawTool.ts';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Separator } from './ui/separator';
import { NumberInput } from './NumberInput.tsx';
import { cn } from '../lib/utils.ts';

const MODES: { mode: WallDrawMode; icon: typeof Slash; key: string }[] = [
  { mode: 'line', icon: Slash, key: 'drawing.modeLine' },
  { mode: 'rect', icon: Square, key: 'drawing.modeRect' },
  { mode: 'arc', icon: Spline, key: 'drawing.modeArc' },
  { mode: 'pick', icon: MousePointerClick, key: 'drawing.modePick' },
];

const LOCATIONS = [
  { value: 'center', key: 'drawing.locCenter' },
  { value: 'exterior', key: 'drawing.locExterior' },
  { value: 'interior', key: 'drawing.locInterior' },
] as const;

const btn = 'flex size-7 items-center justify-center rounded-md transition-colors';

export default function WallDrawOptionsBar({ fieldClass, unitLabel }: { fieldClass: string; unitLabel: string }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const attrs = state.drawingAttrs;
  const opts = wallDrawOptions(attrs);

  const set = (key: string, value: string, resetDrawing = false) => {
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs: withWallDrawOption(attrs, key, value) });
    if (resetDrawing) dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
  };

  return (
    <>
      <Separator orientation="vertical" className="h-4" />
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label={t('drawing.mode')}>
        {MODES.map(({ mode, icon: I, key }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={opts.mode === mode}
            data-wall-mode={mode}
            title={t(key)}
            className={cn(btn, opts.mode === mode
              ? 'bg-[var(--dp-color)]/20 text-[var(--dp-color)]'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
            onClick={() => set(WALL_OPT.mode, mode, true)}
          >
            <I size={14} />
          </button>
        ))}
        <button
          type="button"
          aria-pressed={opts.chain}
          title={t('drawing.chain')}
          className={cn(btn, opts.chain
            ? 'bg-[var(--dp-color)]/20 text-[var(--dp-color)]'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          onClick={() => set(WALL_OPT.chain, opts.chain ? 'false' : 'true')}
        >
          <Link size={13} />
        </button>
      </div>
      <Separator orientation="vertical" className="h-4" />
      <label className="text-[10px] text-muted-foreground">{t('drawing.locationLine')}</label>
      <Select value={opts.loc} onValueChange={(v) => { if (v) set(WALL_OPT.loc, v); }}>
        <SelectTrigger size="sm" className={`${fieldClass} min-w-16 gap-1`} data-wall-loc>
          <span className="truncate">{t(LOCATIONS.find(l => l.value === opts.loc)!.key)}</span>
        </SelectTrigger>
        <SelectContent>
          {LOCATIONS.map(l => <SelectItem key={l.value} value={l.value}>{t(l.key)}</SelectItem>)}
        </SelectContent>
      </Select>
      <label className="text-[10px] text-muted-foreground" title={t('drawing.offsetHint')}>{t('drawing.offset')}</label>
      <div className="flex items-center gap-1" data-wall-offset>
        <NumberInput
          className={`${fieldClass} w-[52px] text-right`}
          value={String(opts.offset)}
          onChange={v => set(WALL_OPT.offset, v)}
          step={0.05}
        />
        <span className="text-[9px] text-muted-foreground select-none">{unitLabel}</span>
      </div>
    </>
  );
}
