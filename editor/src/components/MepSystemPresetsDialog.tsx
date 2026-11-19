import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import type { SystemDef } from '../types.ts';
import { MEP_SYSTEM_PRESETS, DISCIPLINE_OPTIONS, presetSystemRows, type MepSystemPreset } from '../mep/systemPresets.ts';
import { drawingLang } from '../export/drawing/labels.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The project's systems: their codes are shown as added and skipped. */
  existing: SystemDef[];
  /** System codes the model's elements use (pre-checked when missing). */
  usedCodes: ReadonlySet<string>;
  onAdd: (rows: SystemDef[]) => void;
}

const codesOf = (p: MepSystemPreset) => [p.code, ...(p.aliases ?? [])];

/**
 * System library: tick the common systems (SA, RA, CHWS, DCW, FP, PWR …) and
 * add them to global/mep_system.csv in one go, each with its name, discipline
 * and distinct colour. Codes the project already has are shown as added.
 */
export default function MepSystemPresetsDialog({ open, onClose, existing, usedCodes, onAdd }: Props) {
  const { t, i18n } = useTranslation();
  const lang = drawingLang(i18n.language);
  const have = new Set(existing.map(s => s.system_type.trim().toUpperCase()));
  const added = (p: MepSystemPreset) => codesOf(p).some(c => have.has(c));
  const inModel = (p: MepSystemPreset) => codesOf(p).some(c => usedCodes.has(c));
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Pre-check the systems the model already uses but the project lacks
    if (open) setPicked(new Set(MEP_SYSTEM_PRESETS.filter(p => !added(p) && inModel(p)).map(p => p.code)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const available = MEP_SYSTEM_PRESETS.filter(p => !added(p));
  const toggle = (code: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const submit = () => {
    const rows = presetSystemRows(MEP_SYSTEM_PRESETS.map(p => p.code).filter(c => picked.has(c)), existing, usedCodes, lang);
    if (rows.length > 0) onAdd(rows);
    onClose();
  };
  const groups = DISCIPLINE_OPTIONS
    .map(d => ({ ...d, presets: MEP_SYSTEM_PRESETS.filter(p => p.discipline === d.value) }))
    .filter(g => g.presets.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="flex max-h-[80vh] w-[340px] flex-col rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={e => e.stopPropagation()} data-testid="mep-system-presets">
        <div className="mb-1 text-[12px] font-semibold text-foreground">{t('dialog.mepSystemPresets.title')}</div>
        <div className="mb-2 text-[10px] text-muted-foreground">{t('dialog.mepSystemPresets.hint')}</div>
        <div className="mb-2 flex gap-2 text-[10px]">
          <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)] hover:underline"
            onClick={() => setPicked(new Set(available.map(p => p.code)))}>{t('dialog.mepSystemPresets.all')}</button>
          <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)] hover:underline"
            onClick={() => setPicked(new Set(available.filter(inModel).map(p => p.code)))}>{t('dialog.mepSystemPresets.used')}</button>
          <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)] hover:underline"
            onClick={() => setPicked(new Set())}>{t('dialog.mepSystemPresets.none')}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {groups.map(g => (
            <div key={g.value} className="mb-2">
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{t(g.label)}</div>
              {g.presets.map(p => {
                const done = added(p);
                return (
                  <label key={p.code} data-code={p.code}
                    className={cn('flex items-center gap-2 rounded px-1.5 py-[3px] text-[11px]', done ? 'opacity-50' : 'cursor-pointer hover:bg-accent')}>
                    <input type="checkbox" disabled={done} checked={done || picked.has(p.code)} onChange={() => toggle(p.code)} />
                    <span className="size-3 shrink-0 rounded-sm border border-black/20" style={{ backgroundColor: p.color }} />
                    <span className="w-11 shrink-0 font-mono text-[10px] text-foreground">{p.code}</span>
                    <span className="flex-1 truncate text-muted-foreground">{lang === 'zh' ? p.zh : p.en}</span>
                    {done
                      ? <span className="shrink-0 text-[9px] text-muted-foreground">{t('dialog.mepSystemPresets.added')}</span>
                      : inModel(p) && <span className="shrink-0 text-[9px] text-[var(--color-accent)]">{t('dialog.mepSystemPresets.inModel')}</span>}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="cursor-pointer rounded border border-border bg-transparent px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            {t('dialog.cancel', 'Cancel')}
          </button>
          <button type="button" onClick={submit} disabled={picked.size === 0} data-testid="mep-system-presets-add"
            className="cursor-pointer rounded border-none bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {t('dialog.mepSystemPresets.add', { count: picked.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
