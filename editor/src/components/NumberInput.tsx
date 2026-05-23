import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { cn } from '../lib/utils';
import { parseImperialLength } from '../utils/units';

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  /** When set, accept imperial notation (`5'-6"`, `6"`, `5'`) on top of decimal
   *  input. The parsed decimal value is in the chosen unit (`'ft'` or `'in'`),
   *  matching the project unit so we never convert behind the user's back. */
  parseImperial?: 'ft' | 'in';
}

function clampAndRound(val: number, step: number, min?: number, max?: number) {
  const decimals = (step.toString().split('.')[1] || '').length;
  let v = parseFloat(val.toFixed(decimals));
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

/** Format the displayed value to match the step's precision. Avoids surfacing
 *  things like "0.30000000000000004" caused by upstream float arithmetic.
 *  Keeps the raw string if it's still being edited (tracked separately by
 *  pendingValue). */
function formatForDisplay(raw: string, step: number): string {
  if (raw === '' || raw === '-') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const decimals = (step.toString().split('.')[1] || '').length;
  // Trim trailing zeros after the decimal point so "0.300" reads as "0.3".
  const fixed = n.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}

export function NumberInput({ value, onChange, step = 1, min, max, className, parseImperial }: NumberInputProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const nudge = useCallback((delta: number) => {
    // Read from pending (local) value if mid-scroll, otherwise from prop
    const base = pendingValue != null ? pendingValue : value;
    const current = parseFloat(base) || 0;
    const next = clampAndRound(current + delta * step, step, min, max);
    const nextStr = String(next);

    // Update local display immediately
    setPendingValue(nextStr);

    // Debounce the expensive upstream onChange
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      onChange(nextStr);
      setPendingValue(null);
    }, 150);
  }, [pendingValue, value, onChange, step, min, max]);

  // Stable ref for nudge to avoid re-attaching wheel listener
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  // Native wheel listener with { passive: false } so preventDefault works
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      e.stopPropagation();
      nudgeRef.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
  }, [nudge]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (parseImperial) {
      // Defer parse to blur so the user can keep typing `5'-6"` without us
      // rejecting intermediate states. Pending string drives the display.
      setPendingValue(v);
      return;
    }
    if (v === '' || v === '-' || !isNaN(Number(v))) onChange(v);
  }, [onChange, parseImperial]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    if (parseImperial && pendingValue != null) {
      const parsed = parseImperialLength(pendingValue, parseImperial);
      if (parsed != null && Number.isFinite(parsed)) {
        onChange(String(parsed));
      }
      setPendingValue(null);
    }
  }, [parseImperial, pendingValue, onChange]);

  // While editing (focused), show whatever the user has typed verbatim;
  // otherwise format to step precision so float artifacts don't leak through.
  const displayValue = pendingValue ?? (focused ? value : formatForDisplay(value, step));

  return (
    <Tooltip open={focused}>
      <TooltipTrigger
        render={
          <Input
            ref={ref}
            className={cn('tabular-nums', className)}
            type="text"
            inputMode="decimal"
            value={displayValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
          />
        }
      />
      <TooltipContent side="top">{t('input.scrollToAdjust')}</TooltipContent>
    </Tooltip>
  );
}
