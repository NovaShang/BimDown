import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCoreEditorState } from '../state/EditorContext.tsx';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import { formatLength, getProjectUnits, getUnitSuffix, parseImperialLength } from '../utils/units.ts';
import { useUnderlaySnapshot, useUnderlayStore } from './UnderlayContext.tsx';
import type { UnderlayMode } from './store.ts';

function hintKey(mode: UnderlayMode): string {
  switch (mode.kind) {
    case 'calibrate': return mode.points.length === 0 ? 'underlay.hint.calibrate1' : 'underlay.hint.calibrate2';
    case 'move': return mode.base ? 'underlay.hint.move2' : 'underlay.hint.move1';
    case 'rotate': return !mode.center ? 'underlay.hint.rotate1' : !mode.ref ? 'underlay.hint.rotate2' : 'underlay.hint.rotate3';
  }
}

/** Step prompt while an underlay interaction runs (same slot as DrawingHints). */
export function UnderlayHint() {
  const { t } = useTranslation();
  const { mode } = useUnderlaySnapshot();
  if (!mode) return null;
  return (
    <div className="pointer-events-none absolute top-16 left-1/2 z-20 -translate-x-1/2 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="glass-panel rounded-lg border border-border px-3 py-1.5 shadow-[var(--shadow-panel)]">
        <span className="select-none text-[11px] text-muted-foreground" data-testid="underlay-hint">
          {t(hintKey(mode))} · {t('underlay.hint.esc')}
        </span>
      </div>
    </div>
  );
}

/** Asks for the real distance between the two calibration picks. */
export function CalibrateDialog() {
  const store = useUnderlayStore();
  const { calibration } = useUnderlaySnapshot();
  if (!store || !calibration) return null;
  const measured = Math.hypot(calibration.p2.x - calibration.p1.x, calibration.p2.y - calibration.p1.y);
  // Keyed: every new pair of picks starts from a fresh form.
  return <CalibrateForm key={`${calibration.p1.x},${calibration.p1.y},${calibration.p2.x},${calibration.p2.y}`} measured={measured} />;
}

function CalibrateForm({ measured }: { measured: number }) {
  const { t } = useTranslation();
  const store = useUnderlayStore()!;
  const unit = getProjectUnits(useCoreEditorState());
  const [value, setValue] = useState(() => String(Number(measured.toPrecision(6))));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(id);
  }, []);

  const parsed = unit === 'ft' || unit === 'in' ? parseImperialLength(value, unit) : Number(value);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => store.cancelCalibration()}>
      <form
        className="w-72 rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); if (valid) store.applyCalibration(parsed!); }}
        data-testid="underlay-calibrate-dialog"
      >
        <div className="mb-1 text-[12px] font-semibold text-foreground">{t('underlay.dialog.title')}</div>
        <div className="mb-3 text-[11px] text-muted-foreground">{t('underlay.dialog.measured', { length: formatLength(measured, unit) })}</div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('underlay.dialog.distance', { unit: getUnitSuffix(unit).trim() })}
        </label>
        <Input
          ref={inputRef}
          className="mb-4 h-7 text-[12px]"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') store.cancelCalibration(); }}
          inputMode="decimal"
          autoFocus
          data-testid="underlay-calibrate-distance"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="cursor-pointer rounded border border-border bg-transparent px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => store.cancelCalibration()}
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={!valid}
            className={cn(
              'cursor-pointer rounded border-none bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:opacity-90',
              !valid && 'cursor-default opacity-40',
            )}
          >
            {t('underlay.dialog.apply')}
          </button>
        </div>
      </form>
    </div>
  );
}
