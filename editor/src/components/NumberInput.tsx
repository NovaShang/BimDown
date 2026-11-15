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
  placeholder?: string;
}

/** Digits after the decimal point (at most MAX_DECIMALS; float noise ignored). */
const MAX_DECIMALS = 6;
function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(Number(n.toFixed(MAX_DECIMALS)));
  return s.includes('e') ? MAX_DECIMALS : (s.split('.')[1] || '').length;
}

/** A nudge result: at the step's precision or the value's own, whichever is finer
 *  (1.05 + 0.1 → 1.15, not 1.2). */
export function clampAndRound(val: number, step: number, min?: number, max?: number, base?: number) {
  const decimals = Math.max(decimalsOf(step), base != null ? decimalsOf(base) : 0);
  let v = parseFloat(val.toFixed(decimals));
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

/** The displayed value: the stored precision (DN65 is 0.065, not the step's
 *  0.07), without float artifacts like "0.30000000000000004". Keeps the raw
 *  string if it's still being edited (tracked separately by pendingValue). */
export function formatForDisplay(raw: string): string {
  if (raw === '' || raw === '-') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toFixed(MAX_DECIMALS)));
}

export function NumberInput({ value, onChange, step = 1, min, max, className, parseImperial, placeholder }: NumberInputProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const nudge = useCallback((delta: number) => {
    // Read from pending (local) value if mid-scroll, otherwise from prop
    const base = pendingValue != null ? pendingValue : value;
    const current = parseFloat(base) || 0;
    const next = clampAndRound(current + delta * step, step, min, max, current);
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
  // otherwise drop float artifacts (never round to the step).
  const displayValue = pendingValue ?? (focused ? value : formatForDisplay(value));

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
            placeholder={placeholder}
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
