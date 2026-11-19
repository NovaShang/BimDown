import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

/** Small modal yes/no dialog. Esc or a press on the backdrop cancels. */
export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, danger }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="alertdialog" aria-modal="true" aria-label={title} className="w-72 rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="mb-2 text-[12px] font-semibold text-foreground">{title}</div>
        <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="cursor-pointer rounded border border-border bg-transparent px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            {t('dialog.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={cn(
              'cursor-pointer rounded border-none px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:opacity-90',
              danger ? 'bg-red-600' : 'bg-[var(--color-accent)]',
            )}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
