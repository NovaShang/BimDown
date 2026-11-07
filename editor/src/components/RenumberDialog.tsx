import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { showNotice } from '../state/modifyUi.ts';
import { renumberCategories, renumberPatches, type RenumberScope } from '../state/numbering.ts';
import { prefixFor } from '../model/autoNumber.ts';
import { Input } from './ui/input';
import { cn } from '../lib/utils';

const primary = 'cursor-pointer rounded border-none bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40';
const secondary = 'cursor-pointer rounded border border-border bg-transparent px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground';
const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground';

/**
 * Renumber (marks): the categories in the selection / this level / the
 * project, each with its prefix (saved to project_metadata.json), numbered
 * bottom-up and in plan order. Structural categories share one mark per type.
 */
export default function RenumberDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [scope, setScope] = useState<RenumberScope>(state.selectedIds.size > 0 ? 'selection' : 'level');
  const cats = useMemo(() => renumberCategories(state, scope), [state, scope]);
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOn(new Set(cats.keys()));
    setPrefixes(p => {
      const next = { ...p };
      for (const k of cats.keys()) if (next[k] === undefined) next[k] = prefixFor(k, state.project?.metadata.numbering);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const apply = () => {
    const config = { ...(state.project?.metadata.numbering ?? {}) };
    for (const k of on) {
      if (prefixes[k] !== undefined && prefixes[k] !== prefixFor(k, undefined)) config[k] = prefixes[k];
      else delete config[k];
    }
    const patches = renumberPatches(state, scope, on, config);
    dispatch({ type: 'SET_NUMBERING', numbering: config, persist: true });
    const count = [...patches.values()].reduce((s, p) => s + p.size, 0);
    if (count > 0) dispatch({ type: 'APPLY_LEVEL_EDITS', description: `Renumber ${count} elements`, patches });
    showNotice('renumber.done', { count });
    onClose();
  };

  const catLabel = (k: string) => {
    const [table, sub] = k.split('.');
    return t(`renumber.cat.${k}`, { defaultValue: sub ? `${table} · ${sub}` : table });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('renumber.title')} data-testid="renumber-dialog"
        className="max-h-[80vh] w-[380px] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="mb-3 text-[12px] font-semibold text-foreground">{t('renumber.title')}</div>
        <label className={label}>{t('renumber.scope')}</label>
        <div className="mb-3 flex gap-1">
          {(['selection', 'level', 'project'] as const).map(s => (
            <button key={s} type="button" disabled={s === 'selection' && state.selectedIds.size === 0}
              data-testid={`renumber-scope-${s}`}
              className={cn('rounded border px-2 py-1 text-[11px] disabled:opacity-40', scope === s ? 'border-[var(--color-accent)] text-foreground' : 'border-border text-muted-foreground')}
              onClick={() => setScope(s)}>{t(`renumber.scope.${s}`)}</button>
          ))}
        </div>
        {cats.size === 0 ? (
          <div className="text-[11px] text-muted-foreground">{t('renumber.none')}</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="pb-1 font-medium" />
                <th className="pb-1 font-medium">{t('renumber.category')}</th>
                <th className="pb-1 font-medium">{t('renumber.prefix')}</th>
                <th className="pb-1 text-right font-medium">#</th>
              </tr>
            </thead>
            <tbody>
              {[...cats].map(([k, n]) => (
                <tr key={k}>
                  <td className="py-0.5 pr-1"><input type="checkbox" checked={on.has(k)} data-testid={`renumber-on-${k}`}
                    onChange={e => setOn(prev => { const s = new Set(prev); if (e.target.checked) s.add(k); else s.delete(k); return s; })} /></td>
                  <td className="py-0.5 pr-2">{catLabel(k)}</td>
                  <td className="w-24 py-0.5 pr-2"><Input className="h-6 px-1.5 text-[11px]" value={prefixes[k] ?? ''} data-testid={`renumber-prefix-${k}`}
                    onChange={e => setPrefixes(p => ({ ...p, [k]: e.target.value }))} /></td>
                  <td className="py-0.5 text-right tabular-nums text-muted-foreground">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2 text-[10px] text-muted-foreground">{t('renumber.hint')}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={secondary} onClick={onClose}>{t('dialog.cancel')}</button>
          <button type="button" className={primary} disabled={on.size === 0} data-testid="dialog-ok" onClick={apply}>{t('renumber.apply')}</button>
        </div>
      </div>
    </div>
  );
}
