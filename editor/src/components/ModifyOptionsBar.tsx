/**
 * Options bar of the modify tools (Revit's options bar): copy toggles, the
 * rotate centre / typed angle, mirror pick-or-draw, array count / spacing /
 * radial angle / group, offset distance. Bottom centre, like the drawing bar.
 */
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { useModifyOptions, setModifyOptions } from '../tools/modifyOptions.ts';
import { pickRotateCenter } from '../tools/modifyTools.ts';
import { NumberInput } from './NumberInput.tsx';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils.ts';

const fieldClass = 'h-7 w-16 rounded-lg border-input bg-transparent px-2 text-[11px] tabular-nums';
const chip = 'flex h-7 items-center rounded-md px-2 text-[11px] transition-colors cursor-pointer border-none';
const on = 'bg-[var(--accent-dim)] text-[var(--color-accent)]';
const off = 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground';

const TOOLS = new Set(['rotate', 'mirror', 'array', 'align', 'offset', 'paste']);

function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" data-testid={testId}>
      <input type="checkbox" className="accent-[var(--color-accent)]" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function ModifyOptionsBar() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const o = useModifyOptions();
  const tool = state.activeTool;
  if (!TOOLS.has(tool) || state.viewMode !== '2d') return null;
  const ds = state.drawingState;
  const typed = ds?.typed?.length;

  return (
    <div
      data-testid="modify-options"
      className="absolute bottom-[80px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap glass-panel rounded-[10px] border border-border px-3 py-[5px] shadow-[var(--shadow-panel)]"
      onPointerDown={e => e.stopPropagation()}
    >
      <span className="text-[11px] font-medium text-foreground">{t(`modify.${tool}`)}</span>
      <Separator orientation="vertical" className="h-4" />
      {tool === 'rotate' && (
        <>
          <button type="button" className={cn(chip, ds?.modify?.pickCenter ? on : off)} data-testid="rotate-center"
            onClick={() => pickRotateCenter(dispatch, ds)}>{t('modify.placeCenter')}</button>
          <span className="text-[11px] text-muted-foreground">{t('modify.angle')}</span>
          <span className="min-w-[3rem] rounded-md border border-border px-2 py-1 text-[11px] tabular-nums text-foreground" data-testid="rotate-angle">
            {typed ? `${typed}°` : ds?.modify?.angle !== undefined ? `${ds.modify.angle}°` : '—'}
          </span>
          <Toggle checked={o.rotateCopy} onChange={v => setModifyOptions({ rotateCopy: v })} label={t('modify.copy')} testId="rotate-copy" />
          {o.rotateCopy && <Toggle checked={o.renumberCopies} onChange={v => setModifyOptions({ renumberCopies: v })} label={t('modify.renumber')} testId="renumber-copies" />}
        </>
      )}
      {tool === 'mirror' && (
        <>
          <button type="button" className={cn(chip, o.mirrorMode === 'pick' ? on : off)} data-testid="mirror-pick"
            onClick={() => { setModifyOptions({ mirrorMode: 'pick' }); dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify: {} } }); }}>
            {t('modify.pickAxis')}
          </button>
          <button type="button" className={cn(chip, o.mirrorMode === 'draw' ? on : off)} data-testid="mirror-draw"
            onClick={() => { setModifyOptions({ mirrorMode: 'draw' }); dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify: {} } }); }}>
            {t('modify.drawAxis')}
          </button>
          <Toggle checked={o.mirrorCopy} onChange={v => setModifyOptions({ mirrorCopy: v })} label={t('modify.copy')} testId="mirror-copy" />
          {o.mirrorCopy && <Toggle checked={o.renumberCopies} onChange={v => setModifyOptions({ renumberCopies: v })} label={t('modify.renumber')} testId="renumber-copies" />}
        </>
      )}
      {tool === 'array' && (
        <>
          <button type="button" className={cn(chip, o.arrayMode === 'linear' ? on : off)} data-testid="array-linear"
            onClick={() => { setModifyOptions({ arrayMode: 'linear' }); dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify: {} } }); }}>
            {t('modify.linear')}
          </button>
          <button type="button" className={cn(chip, o.arrayMode === 'radial' ? on : off)} data-testid="array-radial"
            onClick={() => { setModifyOptions({ arrayMode: 'radial' }); dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null, modify: {} } }); }}>
            {t('modify.radial')}
          </button>
          <span className="text-[11px] text-muted-foreground">{t('modify.count')}</span>
          <NumberInput className={fieldClass} value={String(o.arrayCount)} step={1} min={2} max={500}
            onChange={v => { const n = parseInt(v, 10); if (n >= 2) setModifyOptions({ arrayCount: n }); }} />
          {o.arrayMode === 'linear' ? (
            <>
              <button type="button" className={cn(chip, !o.arrayFit ? on : off)} data-testid="array-spacing" onClick={() => setModifyOptions({ arrayFit: false })}>{t('modify.spacing')}</button>
              <button type="button" className={cn(chip, o.arrayFit ? on : off)} data-testid="array-fit" onClick={() => setModifyOptions({ arrayFit: true })}>{t('modify.fit')}</button>
            </>
          ) : (
            <>
              <span className="text-[11px] text-muted-foreground">{t('modify.angle')}</span>
              <NumberInput className={fieldClass} value={String(o.arrayAngle)} step={15} min={-360} max={360}
                onChange={v => { const n = parseFloat(v); if (Number.isFinite(n) && n !== 0) setModifyOptions({ arrayAngle: n }); }} />
            </>
          )}
          <Toggle checked={o.arrayGroup} onChange={v => setModifyOptions({ arrayGroup: v })} label={t('modify.groupCopies')} testId="array-group" />
          {!o.arrayGroup && <Toggle checked={o.renumberCopies} onChange={v => setModifyOptions({ renumberCopies: v })} label={t('modify.renumber')} testId="renumber-copies" />}
          {typed && <span className="rounded-md border border-border px-2 py-1 text-[11px] tabular-nums text-foreground" data-testid="array-typed">{t('modify.distance')} {typed}</span>}
        </>
      )}
      {tool === 'offset' && (
        <>
          <span className="text-[11px] text-muted-foreground">{t('modify.distance')}</span>
          <NumberInput className={fieldClass} value={typed ?? String(o.offsetDistance)} step={0.05} min={0.001}
            onChange={v => { const n = parseFloat(v); if (n > 0) setModifyOptions({ offsetDistance: n }); }} />
          <Toggle checked={o.offsetCopy} onChange={v => setModifyOptions({ offsetCopy: v })} label={t('modify.copy')} testId="offset-copy" />
        </>
      )}
      {(tool === 'align' || tool === 'paste') && (
        <span className="text-[11px] text-muted-foreground">{t(tool === 'align' ? (ds?.pick ? 'hint.align2' : 'hint.align') : 'hint.paste')}</span>
      )}
      {tool === 'paste' && <Toggle checked={o.renumberCopies} onChange={v => setModifyOptions({ renumberCopies: v })} label={t('modify.renumber')} testId="renumber-copies" />}
    </div>
  );
}
