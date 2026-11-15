/**
 * Dialogs of the modify / level / selection commands: pick levels (copy to
 * levels, paste aligned to selected levels), duplicate level, edit level
 * (name, number, elevation, move the levels above), selection filter, save
 * selection, and the keyboard shortcut cheat sheet.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { openDialog, showNotice, useModifyUi, type ModifyDialog } from '../state/modifyUi.ts';
import { filterSelection, selectionCategories } from '../state/selectionOps.ts';
import { pasteAligned, readClipboard } from '../state/clipboardCommands.ts';
import { LAYER_STYLES } from '../types.ts';
import { formatElevation, getProjectUnits } from '../utils/units.ts';
import { SINGLE_KEYS, TWO_LETTER, type Shortcut, type ShortcutGroup } from '../tools/shortcuts.ts';
import { Input } from './ui/input';
import RenumberDialog from './RenumberDialog.tsx';
import { FLOOR_SLAB_TABLES } from '../state/levelEdits.ts';
import { toElementId } from '../model/ids.ts';
import { cn } from '../lib/utils';
import { levelLabel } from '../model/displayNames.ts';

const primary = 'cursor-pointer rounded border-none bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40';
const secondary = 'cursor-pointer rounded border border-border bg-transparent px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground';
const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground';

function Modal({ title, onClose, children, wide, testId }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  useEffect(() => {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
        className={cn('max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl', wide ? 'w-[560px]' : 'w-72')}>
        <div className="mb-3 text-[12px] font-semibold text-foreground">{title}</div>
        {children}
      </div>
    </div>
  );
}

function Buttons({ onClose, onOk, okLabel, disabled }: { onClose: () => void; onOk: () => void; okLabel: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className={secondary} onClick={onClose}>{t('dialog.cancel')}</button>
      <button type="button" className={primary} disabled={disabled} data-testid="dialog-ok" onClick={() => { onOk(); onClose(); }}>{okLabel}</button>
    </div>
  );
}

function LevelsDialog({ mode, onClose }: { mode: 'copy' | 'paste'; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const unit = getProjectUnits(state);
  const levels = [...(state.project?.levels ?? [])].reverse();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [roofOnTop, setRoofOnTop] = useState(true);
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Copying floor slabs to the top level: offer to make them roof slabs.
  const topId = levels[0]?.id;
  const hasFloorSlabs = mode === 'copy' && [...state.selectedIds].some(sid => {
    const el = state.document?.elements.get(toElementId(sid));
    return !!el && FLOOR_SLAB_TABLES.has(el.tableName) && (el.attrs.function || 'floor') === 'floor';
  });
  const ok = async () => {
    const ids = [...picked];
    if (mode === 'copy') {
      dispatch({ type: 'COPY_TO_LEVELS', ids: [...state.selectedIds], levelIds: ids, roofOnTop: hasFloorSlabs && roofOnTop });
      showNotice('notice.copiedToLevels', { count: ids.length });
      return;
    }
    const p = await readClipboard();
    if (!p) { showNotice('notice.clipboardEmpty'); return; }
    const err = pasteAligned(state, dispatch, p, { levels: ids });
    showNotice(err ?? 'notice.pastedToLevels', { count: ids.length });
  };
  return (
    <Modal title={t(mode === 'copy' ? 'levels.copyTo' : 'levels.pasteTo')} onClose={onClose} testId="levels-dialog">
      <div className="flex flex-col gap-1">
        {levels.map(l => {
          const disabled = mode === 'copy' && l.id === state.currentLevel;
          return (
            <label key={l.id} className={cn('flex items-center gap-2 rounded px-2 py-1 text-[11px]', disabled ? 'opacity-40' : 'cursor-pointer hover:bg-accent')}>
              <input type="checkbox" disabled={disabled} checked={picked.has(l.id)} onChange={() => toggle(l.id)} data-level={l.id} />
              <span className="flex-1">{levelLabel(t, l)}</span>
              <span className="text-[9px] tabular-nums text-muted-foreground">{formatElevation(l.elevation, unit)}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 text-[10px]">
        <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)]"
          onClick={() => setPicked(new Set(levels.filter(l => mode !== 'copy' || l.id !== state.currentLevel).map(l => l.id)))}>{t('dialog.all')}</button>
        <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)]" onClick={() => setPicked(new Set())}>{t('dialog.none')}</button>
      </div>
      {hasFloorSlabs && topId && picked.has(topId) && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px]">
          <input type="checkbox" checked={roofOnTop} onChange={e => setRoofOnTop(e.target.checked)} data-testid="copy-roof-on-top" />
          <span>{t('levels.roofOnTop')}</span>
        </label>
      )}
      <Buttons onClose={onClose} onOk={ok} okLabel={t(mode === 'copy' ? 'levels.copy' : 'ctx.paste')} disabled={picked.size === 0} />
    </Modal>
  );
}

function nextLevelId(levels: { id: string }[]): { id: string; n: number } {
  const ids = new Set(levels.map(l => l.id));
  let n = 1;
  while (ids.has(`lv-${n}`)) n++;
  return { id: `lv-${n}`, n };
}

function DuplicateLevelDialog({ levelId, onClose }: { levelId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const levels = state.project?.levels ?? [];
  const src = levels.find(l => l.id === levelId);
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  const top = sorted[sorted.length - 1];
  const storey = (() => {
    const i = sorted.findIndex(l => l.id === levelId);
    const above = sorted[i + 1];
    return above && src ? above.elevation - src.elevation : 3;
  })();
  const [name, setName] = useState(`${src?.name || levelId} ${t('levels.copySuffix')}`);
  const [elevation, setElevation] = useState(String(Math.round(((top?.elevation ?? 0) + (storey > 0 ? storey : 3)) * 1000) / 1000));
  const ok = () => {
    const e = parseFloat(elevation);
    if (!Number.isFinite(e)) return;
    const { id, n } = nextLevelId(levels);
    dispatch({ type: 'DUPLICATE_LEVEL', levelId, level: { id, number: String(n), name: name.trim() || id, elevation: e } });
    showNotice('notice.levelDuplicated', { name: name.trim() || id });
  };
  return (
    <Modal title={t('levels.duplicate')} onClose={onClose} testId="duplicate-level-dialog">
      <p className="mb-3 text-[11px] text-muted-foreground">{t('levels.duplicateHint', { name: src?.name || levelId })}</p>
      <label className={label}>{t('dialog.name')}</label>
      <Input className="mb-3 h-7 text-[12px]" value={name} onChange={e => setName(e.target.value)} autoFocus data-testid="dup-name" />
      <label className={label}>{t('dialog.elevation')}</label>
      <Input className="h-7 text-[12px]" type="number" step="any" value={elevation} onChange={e => setElevation(e.target.value)} data-testid="dup-elevation" />
      <Buttons onClose={onClose} onOk={ok} okLabel={t('levels.duplicate')} />
    </Modal>
  );
}

function EditLevelDialog({ levelId, onClose }: { levelId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const level = state.project?.levels.find(l => l.id === levelId);
  const [name, setName] = useState(level?.name ?? '');
  const [number, setNumber] = useState(level?.number ?? '');
  const [elevation, setElevation] = useState(String(level?.elevation ?? 0));
  const [moveAbove, setMoveAbove] = useState(true);
  if (!level) return null;
  const e = parseFloat(elevation);
  const changed = Number.isFinite(e) && e !== level.elevation;
  const ok = () => {
    if (!Number.isFinite(e)) return;
    dispatch({ type: 'RENAME_LEVEL', levelId, name: name.trim() || level.name, number: number.trim() || level.number, elevation: e, moveAbove: changed && moveAbove });
  };
  return (
    <Modal title={t('levels.edit')} onClose={onClose} testId="edit-level-dialog">
      <label className={label}>{t('dialog.name')}</label>
      <Input className="mb-3 h-7 text-[12px]" value={name} onChange={ev => setName(ev.target.value)} autoFocus />
      <label className={label}>{t('levels.number')}</label>
      <Input className="mb-3 h-7 text-[12px]" value={number} onChange={ev => setNumber(ev.target.value)} />
      <label className={label}>{t('dialog.elevation')}</label>
      <Input className="mb-2 h-7 text-[12px]" type="number" step="any" value={elevation} onChange={ev => setElevation(ev.target.value)} data-testid="level-elevation" />
      {changed && (
        <label className="mb-1 flex cursor-pointer items-start gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" className="mt-0.5" checked={moveAbove} onChange={ev => setMoveAbove(ev.target.checked)} data-testid="move-above" />
          <span>{t('levels.moveAbove')}</span>
        </label>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">{t('levels.elevationRule')}</p>
      <Buttons onClose={onClose} onOk={ok} okLabel={t('dialog.save')} />
    </Modal>
  );
}

function FilterDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const cats = useMemo(() => selectionCategories(state), [state]);
  const [keep, setKeep] = useState<Set<string>>(() => new Set(cats.map(c => c.table)));
  const total = cats.reduce((n, c) => n + (keep.has(c.table) ? c.count : 0), 0);
  return (
    <Modal title={t('filter.title')} onClose={onClose} testId="filter-dialog">
      <div className="flex flex-col gap-0.5">
        {cats.map(c => {
          const style = LAYER_STYLES[c.table];
          return (
            <label key={c.table} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-accent">
              <input type="checkbox" checked={keep.has(c.table)} data-table={c.table}
                onChange={() => setKeep(k => { const n = new Set(k); if (n.has(c.table)) n.delete(c.table); else n.add(c.table); return n; })} />
              <span className="flex-1">{style ? t(`display.${style.displayName}`) : c.table}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{c.count}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px]">
        <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)]" onClick={() => setKeep(new Set(cats.map(c => c.table)))}>{t('dialog.all')}</button>
        <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-[var(--color-accent)]" onClick={() => setKeep(new Set())}>{t('dialog.none')}</button>
        <span className="ml-auto text-muted-foreground">{t('filter.total', { count: total })}</span>
      </div>
      <Buttons onClose={onClose} onOk={() => filterSelection(state, dispatch, keep)} okLabel={t('type.ok')} disabled={keep.size === 0} />
    </Modal>
  );
}

function SaveSetDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const [name, setName] = useState(() => `${t('selectionSet.default')} ${(state.selectionSets?.length ?? 0) + 1}`);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => ref.current?.select(), 0); }, []);
  return (
    <Modal title={t('selectionSet.save')} onClose={onClose} testId="save-set-dialog">
      <label className={label}>{t('dialog.name')}</label>
      <Input ref={ref} className="h-7 text-[12px]" value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { dispatch({ type: 'SAVE_SELECTION_SET', name }); onClose(); } }} />
      <Buttons onClose={onClose} onOk={() => dispatch({ type: 'SAVE_SELECTION_SET', name })} okLabel={t('dialog.save')} disabled={!name.trim()} />
    </Modal>
  );
}

const GROUP_ORDER: ShortcutGroup[] = ['draw', 'modify', 'annotate', 'select', 'view'];

/** One row per command: its two-letter and single-key shortcuts together. */
function merged(list: Shortcut[]): [string, string[]][] {
  const byLabel = new Map<string, string[]>();
  for (const s of list) byLabel.set(s.labelKey, [...(byLabel.get(s.labelKey) ?? []), s.keys]);
  return [...byLabel];
}

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const rows = (list: Shortcut[], g: ShortcutGroup) => list.filter(s => s.group === g);
  return (
    <Modal title={t('shortcut.title')} onClose={onClose} wide testId="shortcuts-panel">
      <p className="mb-3 text-[11px] text-muted-foreground">{t('shortcut.intro')}</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {GROUP_ORDER.map(g => (
          <div key={g}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t(`shortcut.group.${g}`)}</div>
            {merged([...rows(TWO_LETTER, g), ...rows(SINGLE_KEYS, g)]).map(([labelKey, keys]) => (
              <div key={labelKey} className="flex items-center justify-between py-[2px] text-[11px]">
                <span className="text-foreground">{t(labelKey)}</span>
                <span className="flex gap-1">
                  {keys.map(k => <kbd key={k} className="rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">{k}</kbd>)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function ModifyDialogs() {
  const ui = useModifyUi();
  const close = () => openDialog(null);
  const d: ModifyDialog | null = ui.dialog;
  if (!d) return null;
  switch (d.kind) {
    case 'levels': return <LevelsDialog mode={d.mode} onClose={close} />;
    case 'duplicateLevel': return <DuplicateLevelDialog levelId={d.levelId} onClose={close} />;
    case 'editLevel': return <EditLevelDialog levelId={d.levelId} onClose={close} />;
    case 'filter': return <FilterDialog onClose={close} />;
    case 'saveSet': return <SaveSetDialog onClose={close} />;
    case 'shortcuts': return <ShortcutsPanel onClose={close} />;
    case 'renumber': return <RenumberDialog onClose={close} />;
  }
}
