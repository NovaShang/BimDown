import { useCallback, useRef } from 'react';
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

export function NumberInput({ value, onChange, step = 1, min, max, className }: NumberInputProps) {
  const ref = useRef<HTMLInputElement>(null);

  const nudge = useCallback((delta: number) => {
    const current = parseFloat(value) || 0;
    let next = current + delta * step;
    // Round to avoid floating point drift
    const decimals = (step.toString().split('.')[1] || '').length;
    next = parseFloat(next.toFixed(decimals));
    if (min != null && next < min) next = min;
    if (max != null && next > max) next = max;
    onChange(String(next));
  }, [value, onChange, step, min, max]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    nudge(e.deltaY < 0 ? 1 : -1);
  }, [nudge]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
  }, [nudge]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (v === '' || v === '-' || !isNaN(Number(v))) onChange(v);
  }, [onChange]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Input
          ref={ref}
          className={cn('cursor-ns-resize tabular-nums focus:cursor-text', className)}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={handleChange}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        />
      </TooltipTrigger>
      <TooltipContent side="top">滚动调整</TooltipContent>
    </Tooltip>
  );
}
