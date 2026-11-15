import { useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * Number field that commits on Enter / blur (Esc reverts) instead of on every
 * keystroke, for values that drive geometry (typing "2.4" must not apply 2,
 * then 2.4). Commits only finite numbers > 0 (or '' when `allowEmpty`).
 */
export function CommitNumberInput({ value, onCommit, className, disabled, placeholder, allowEmpty, testId, title }: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  testId?: string;
  title?: string;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => { draftRef.current = v; setDraftState(v); };
  const commit = () => {
    const d = draftRef.current;
    setDraft(null);
    if (d === null || d.trim() === value) return;
    if (d.trim() === '') { if (allowEmpty) onCommit(''); return; }
    const n = Number(d.trim().replace(',', '.'));
    if (Number.isFinite(n) && n > 0) onCommit(String(n));
  };
  return (
    <input
      className={cn('tabular-nums', className)} type="text" inputMode="decimal"
      value={draft ?? value} placeholder={placeholder} disabled={disabled} title={title} data-testid={testId}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
      }}
    />
  );
}
