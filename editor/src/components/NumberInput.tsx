import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { cn } from '../lib/utils';

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
}

function clampAndRound(val: number, step: number, min?: number, max?: number) {
  const decimals = (step.toString().split('.')[1] || '').length;
  let v = parseFloat(val.toFixed(decimals));
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

export function NumberInput({ value, onChange, step = 1, min, max, className }: NumberInputProps) {
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
    if (v === '' || v === '-' || !isNaN(Number(v))) onChange(v);
  }, [onChange]);

  const displayValue = pendingValue ?? value;

  return (
    <Tooltip open={focused}>
      <TooltipTrigger asChild>
        <Input
          ref={ref}
          className={cn('tabular-nums', className)}
          type="text"
          inputMode="decimal"
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{t('input.scrollToAdjust')}</TooltipContent>
    </Tooltip>
  );
}
