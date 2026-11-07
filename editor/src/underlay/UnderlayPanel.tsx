import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Eye, EyeOff, FileImage, FileText, Lock, LockOpen, Move, PenTool, Plus, RotateCw, Ruler, Trash2 } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { formatLength, getProjectUnits } from '../utils/units.ts';
import { NumberInput } from '../components/NumberInput.tsx';
import { cn } from '../lib/utils';
import { useUnderlaySnapshot, useUnderlayStore } from './UnderlayContext.tsx';
import { assetKey, UnderlayImportError, type AssetState, type UnderlayMode } from './store.ts';
import { UNDERLAY_ACCEPT, underlayKind, type Underlay } from './types.ts';
import { normalizeDeg } from './transform.ts';

const ICON_BTN = 'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent';

/** "Underlays" card of the left panel: import, list, and the selected underlay's settings. */
export default function UnderlayPanel() {
  const { t } = useTranslation();
  const store = useUnderlayStore();
  const snap = useUnderlaySnapshot();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!store || state.viewMode !== '2d') return null;

  const editable = !state.readonly;
  const items = snap.underlays.filter(u => u.levelId === state.currentLevel);
  if (!editable && items.length === 0) return null;
  const selected = items.find(u => u.id === snap.selectedId) ?? null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await store.importFile(file);
    } catch (e) {
      const reason = e instanceof UnderlayImportError ? e.reason : 'failed';
      const detail = e instanceof Error && e.message !== reason ? ` (${e.message})` : '';
      window.alert(t(`underlay.error.${reason}`) + detail);
    }
  };

  const start = (kind: UnderlayMode['kind'], id: string) => {
    store.startMode(kind, id);
    dispatch({ type: 'SET_TOOL', tool: 'underlay' });
  };

  return (
    <div data-tour="underlays" className="glass-panel flex shrink-0 max-h-[45%] flex-col rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]">
      <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('underlay.title')}</span>
        {editable && store.canEdit && (
          <button
            className="flex size-4 cursor-pointer items-center justify-center rounded border-none bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            onClick={() => fileRef.current?.click()}
            disabled={snap.importing}
            title={t('underlay.import')}
            data-testid="underlay-import"
          >
            <Plus size={12} />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={UNDERLAY_ACCEPT}
          className="hidden"
          data-testid="underlay-file"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        {snap.importing && <div className="px-2 py-1 text-[10px] text-muted-foreground">{t('underlay.importing')}</div>}
        {items.length === 0 && !snap.importing && (
          <button
            className="cursor-pointer rounded border border-dashed border-border bg-transparent px-2 py-2 text-center text-[10px] leading-snug text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => fileRef.current?.click()}
            disabled={!store.canEdit}
          >
            {t('underlay.empty')}
          </button>
        )}
        {items.map(u => (
          <UnderlayRow
            key={u.id}
            u={u}
            asset={snap.assets.get(assetKey(u))}
            selected={u.id === snap.selectedId}
            editable={editable}
            onSelect={() => store.select(u.id === snap.selectedId ? null : u.id)}
            onToggle={patch => store.update(u.id, patch)}
          />
        ))}
        {selected && (
          <UnderlaySettings
            u={selected}
            asset={snap.assets.get(assetKey(selected))}
            mode={snap.mode?.id === selected.id ? snap.mode : null}
            editable={editable}
            unit={getProjectUnits(state)}
            onStart={kind => start(kind, selected.id)}
          />
        )}
      </div>
    </div>
  );
}

function UnderlayRow({ u, asset, selected, editable, onSelect, onToggle }: {
  u: Underlay;
  asset: AssetState | undefined;
  selected: boolean;
  editable: boolean;
  onSelect: () => void;
  onToggle: (patch: Partial<Underlay>) => void;
}) {
  const { t } = useTranslation();
  const kind = underlayKind(u.file);
  const KindIcon = kind === 'dxf' ? PenTool : kind === 'pdf' ? FileText : FileImage;
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded px-1.5 py-[3px] text-[11px]',
        selected ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]' : 'text-muted-foreground hover:bg-accent',
        !u.visible && 'opacity-50',
      )}
    >
      <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left text-inherit" onClick={onSelect} title={u.file}>
        <KindIcon size={12} className="shrink-0" />
        <span className="truncate">{u.name || u.file}</span>
        {asset?.status === 'loading' && <span className="shrink-0 text-[9px] text-muted-foreground">…</span>}
        {asset?.status === 'error' && <span className="shrink-0 text-[9px] text-red-400" title={asset.message}>!</span>}
      </button>
      {editable && (
        <button className={ICON_BTN} onClick={() => onToggle({ locked: !u.locked })} title={t(u.locked ? 'underlay.unlock' : 'underlay.lock')}>
          {u.locked ? <Lock size={11} /> : <LockOpen size={11} className="opacity-50" />}
        </button>
      )}
      <button className={ICON_BTN} onClick={() => onToggle({ visible: !u.visible })} title={t(u.visible ? 'underlay.hide' : 'underlay.show')}>
        {u.visible ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>
    </div>
  );
}

/** "1 px", "1 pt" or "1 DXF unit" — the underlay's local unit. */
function localUnitKey(u: Underlay): string {
  const kind = underlayKind(u.file);
  return kind === 'dxf' ? 'underlay.unit.dxf' : kind === 'pdf' ? 'underlay.unit.pdf' : 'underlay.unit.px';
}

function UnderlaySettings({ u, asset, mode, editable, unit, onStart }: {
  u: Underlay;
  asset: AssetState | undefined;
  mode: UnderlayMode | null;
  editable: boolean;
  unit: ReturnType<typeof getProjectUnits>;
  onStart: (kind: UnderlayMode['kind']) => void;
}) {
  const { t } = useTranslation();
  const store = useUnderlayStore()!;
  const canTransform = editable && !u.locked && asset?.status === 'ready';
  const pageCount = asset?.status === 'ready' && asset.kind === 'pdf' ? asset.pageCount ?? 1 : 0;
  const dxfLayers = asset?.status === 'ready' && asset.kind === 'dxf' ? asset.drawing.layers : [];
  const hidden = new Set(u.hiddenLayers);

  const modeBtn = (kind: UnderlayMode['kind'], Icon: typeof Ruler, label: string) => (
    <button
      className={cn(
        'flex flex-1 cursor-pointer flex-col items-center gap-0.5 rounded border px-1 py-1 text-[9px] transition-colors disabled:cursor-default disabled:opacity-35',
        mode?.kind === kind
          ? 'border-[var(--color-accent)] bg-[var(--accent-dim)] text-[var(--color-accent)]'
          : 'border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      disabled={!canTransform}
      onClick={() => onStart(kind)}
      data-testid={`underlay-${kind}`}
    >
      <Icon size={13} />
      {label}
    </button>
  );

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border/60 px-2 py-2 text-[10px] text-muted-foreground">
      {asset?.status === 'error' && <div className="text-red-400">{t('underlay.loadError', { message: asset.message })}</div>}

      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0">{t('underlay.opacity')}</span>
        <input
          type="range" min={5} max={100} step={5}
          value={Math.round(u.opacity * 100)}
          onChange={e => store.update(u.id, { opacity: Number(e.target.value) / 100 })}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
          data-testid="underlay-opacity"
        />
        <span className="w-7 shrink-0 text-right tabular-nums">{Math.round(u.opacity * 100)}%</span>
      </label>

      {editable && (
        <div className="flex gap-1">
          {modeBtn('calibrate', Ruler, t('underlay.calibrate'))}
          {modeBtn('move', Move, t('underlay.move'))}
          {modeBtn('rotate', RotateCw, t('underlay.rotate'))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0">{t('underlay.rotation')}</span>
        {canTransform ? (
          <NumberInput
            value={String(Math.round(u.rotation * 100) / 100)}
            step={0.5}
            onChange={v => {
              const n = Number(v);
              if (!Number.isFinite(n)) return;
              store.setRotation(u.id, normalizeDeg(n));
            }}
            className="h-6 flex-1 text-[10px]"
          />
        ) : (
          <span className="tabular-nums">{Math.round(u.rotation * 100) / 100}°</span>
        )}
      </div>

      <div className="tabular-nums" title={t('underlay.scaleHint')}>
        {t(localUnitKey(u))} = {formatLength(u.scale, unit)}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <span className="w-12 shrink-0">{t('underlay.page')}</span>
          <button className={ICON_BTN} disabled={!editable || u.page <= 1} onClick={() => store.update(u.id, { page: u.page - 1 })}>
            <ChevronLeft size={12} />
          </button>
          <span className="tabular-nums">{u.page} / {pageCount}</span>
          <button className={ICON_BTN} disabled={!editable || u.page >= pageCount} onClick={() => store.update(u.id, { page: u.page + 1 })}>
            <ChevronRight size={12} />
          </button>
        </div>
      )}

      {dxfLayers.length > 0 && (
        <div className="flex flex-col gap-px">
          <span className="mb-0.5">{t('underlay.layers')}</span>
          <div className="max-h-32 overflow-y-auto">
            {dxfLayers.map(l => (
              <label key={l.name} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-[2px] hover:bg-accent">
                <input
                  type="checkbox"
                  checked={!hidden.has(l.name)}
                  onChange={() => store.update(u.id, {
                    hiddenLayers: hidden.has(l.name) ? u.hiddenLayers.filter(n => n !== l.name) : [...u.hiddenLayers, l.name],
                  })}
                  className="size-3 accent-[var(--color-accent)]"
                />
                <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: l.color }} />
                <span className="truncate">{l.name}</span>
                <span className="ml-auto shrink-0 text-[9px] tabular-nums opacity-60">{l.count}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {editable && (
        <button
          className="flex cursor-pointer items-center justify-center gap-1 rounded border border-border bg-transparent px-2 py-1 text-[10px] text-red-400 hover:bg-accent"
          onClick={() => { if (window.confirm(t('underlay.deleteConfirm'))) store.remove(u.id); }}
          data-testid="underlay-delete"
        >
          <Trash2 size={11} /> {t('underlay.delete')}
        </button>
      )}
    </div>
  );
}
