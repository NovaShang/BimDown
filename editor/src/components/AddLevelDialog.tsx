import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';

interface AddLevelDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (name: string, elevation: number) => void;
  defaultName: string;
  defaultElevation: number;
  title?: string;
  confirmLabel?: string;
}

export default function AddLevelDialog({ open, onClose, onConfirm, defaultName, defaultElevation, title, confirmLabel }: AddLevelDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [elevation, setElevation] = useState(String(defaultElevation));
  const nameRef = useRef<HTMLInputElement>(null);

  const dialogTitle = title ?? t('dialog.addLevel');
  const dialogConfirm = confirmLabel ?? t('dialog.add');

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setElevation(String(defaultElevation));
      setTimeout(() => nameRef.current?.select(), 0);
    }
  }, [open, defaultName, defaultElevation]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const elev = parseFloat(elevation);
    if (isNaN(elev)) return;
    onConfirm(name.trim() || defaultName, elev);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <form
        className="w-72 rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="mb-3 text-[12px] font-semibold text-foreground">{dialogTitle}</div>

        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('dialog.name')}</label>
        <input
          ref={nameRef}
          className="mb-3 block w-full rounded border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[var(--color-accent)]"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />

        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('dialog.elevation')}</label>
        <input
          className="mb-4 block w-full rounded border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[var(--color-accent)]"
          type="number"
          step="any"
          value={elevation}
          onChange={e => setElevation(e.target.value)}
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={cn(
              'rounded px-3 py-1.5 text-[11px] font-medium transition-colors',
              'border border-border cursor-pointer bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={onClose}
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            className={cn(
              'rounded px-3 py-1.5 text-[11px] font-medium transition-colors',
              'border-none cursor-pointer bg-[var(--color-accent)] text-white hover:opacity-90'
            )}
          >
            {dialogConfirm}
          </button>
        </div>
      </form>
    </div>
  );
}
