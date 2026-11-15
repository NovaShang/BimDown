/**
 * Sheet editor: the sheet list (create, number, name, paper, revision), the
 * sheet itself at true paper proportions with its title block, and a palette
 * of views to drag onto it — plans per level, sections, elevations, schedules
 * and the legend. A placed viewport can be moved by dragging, given a scale,
 * a title (and a discipline for plans) or removed. Edits are written to
 * global/sheet.csv + sheet_viewport.csv; title-block project fields to
 * project_metadata.json. Export: the set as one PDF, or one DXF per sheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { SCHEDULES } from '../schedule/schedules.ts';
import { drawingLabel, drawingLang } from '../export/drawing/labels.ts';
import { composeSheet, sheetFrame, SheetDrawings, type PlacedViewport } from '../export/drawing/sheetCompose.ts';
import { exportSheetSetPdf, exportSheetSetDxf } from '../export/exportSheets.ts';
import type { DrawingDiscipline } from '../export/drawing/types.ts';
import { hasPlan } from '../export/drawing/plan.ts';
import ConfirmDialog from '../components/ConfirmDialog.tsx';
import { cn } from '../lib/utils';
import { DrawingItemsSvg } from './DrawingSvg.tsx';
import { newSheet, nextViewportId } from './sheetsIO.ts';
import {
  SHEET_PAPERS, type SheetDef, type SheetPaper, type SheetSet, type ViewportDef, type ViewportType,
} from './sheetTypes.ts';

const DRAG_MIME = 'application/x-bimdown-view';
const SCALES = [20, 50, 100, 200, 500, 1000];
const DISCIPLINES: DrawingDiscipline[] = ['architecture', 'structure', 'mep', 'all'];
const ELEVATIONS = ['north', 'south', 'east', 'west'] as const;

type ViewSpec = Pick<ViewportDef, 'type' | 'levelId' | 'viewId' | 'schedule' | 'discipline'>;

const BTN = 'flex h-7 cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40';
const INPUT = 'h-6 w-full rounded-md border border-border bg-[var(--bg-input)] px-1.5 text-[11px] disabled:opacity-60';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground" title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Text input committing on blur / Enter. */
function TextField({ label, value, onCommit, disabled, hint, testId, placeholder }: {
  label: string; value: string; onCommit: (v: string) => void; disabled?: boolean; hint?: string; testId?: string; placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <input key={value} className={INPUT} defaultValue={value} disabled={disabled} data-testid={testId} placeholder={placeholder}
        onBlur={e => { if (e.target.value !== value) onCommit(e.target.value); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </Field>
  );
}

export default function SheetsPanel({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const project = state.project;
  const readonly = state.readonly;
  const lang = drawingLang(i18n.language);
  const set: SheetSet = useMemo(() => project?.sheets ?? { sheets: [], viewports: [] }, [project?.sheets]);
  const [currentId, setCurrentId] = useState<string | null>(set.sheets[0]?.id ?? null);
  const sheet = set.sheets.find(s => s.id === currentId) ?? set.sheets[0] ?? null;
  const [selectedVp, setSelectedVp] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SheetDef | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'dxf' | null>(null);
  const [error, setError] = useState('');

  // Model drawings are cached per model state, not per sheet edit: moving a viewport never re-renders it
  const drawings = useMemo(() => project && new SheetDrawings({ project, grids: state.grids, lang, date: new Date() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.floors, project?.globalLayers, project?.levels, project?.sections, project?.viewAnnotations, project?.types, project?.metadata, state.grids, lang]);
  const composed = useMemo(() => (sheet && drawings ? composeSheet(sheet, set, drawings) : null), [sheet, set, drawings]);

  const update = useCallback((next: SheetSet) => dispatch({ type: 'UPDATE_SHEETS', sheets: next, persist: true }), [dispatch]);
  const updateSheet = (patch: Partial<SheetDef>) => {
    if (!sheet) return;
    update({ ...set, sheets: set.sheets.map(s => (s.id === sheet.id ? { ...s, ...patch } : s)) });
  };
  const updateVp = (id: string, patch: Partial<ViewportDef>) =>
    update({ ...set, viewports: set.viewports.map(v => (v.id === id ? { ...v, ...patch } : v)) });
  const removeVp = (id: string) => {
    update({ ...set, viewports: set.viewports.filter(v => v.id !== id) });
    setSelectedVp(null);
  };
  const createSheet = () => {
    // Structural / MEP views number their sheets S-101 / M-101
    const s = { ...newSheet(set, undefined, state.activeDiscipline), name: '' };
    update({ ...set, sheets: [...set.sheets, s] });
    setCurrentId(s.id);
    setSelectedVp(null);
  };
  const deleteSheet = (s: SheetDef) => {
    update({ sheets: set.sheets.filter(x => x.id !== s.id), viewports: set.viewports.filter(v => v.sheetId !== s.id) });
    if (currentId === s.id) setCurrentId(set.sheets.find(x => x.id !== s.id)?.id ?? null);
  };

  /** Place a view: plans / sections / elevations at the largest standard scale that fits the free area. */
  const place = (spec: ViewSpec, x: number, y: number) => {
    if (!sheet || !drawings || readonly) return;
    const F = sheetFrame(sheet.paper);
    const vp: ViewportDef = {
      id: nextViewportId(set), sheetId: sheet.id, type: spec.type, levelId: spec.levelId, viewId: spec.viewId,
      schedule: spec.schedule, discipline: spec.discipline, scale: 100,
      x: Math.round(x), y: Math.round(y), title: '',
    };
    if (spec.type === 'plan' || spec.type === 'section' || spec.type === 'elevation') {
      vp.scale = drawings.fitScale(vp, { w: F.area.w * 0.92, h: F.area.h * 0.85 });
    }
    update({ ...set, viewports: [...set.viewports, vp] });
    setSelectedVp(vp.id);
  };

  // Delete removes the selected viewport
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (e.key === 'Escape') { if (selectedVp) setSelectedVp(null); else onClose(); e.stopPropagation(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVp && !readonly) { e.preventDefault(); e.stopPropagation(); removeVp(selectedVp); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const runExport = async (kind: 'pdf' | 'dxf') => {
    if (!project || !drawings) return;
    setBusy(kind);
    setError('');
    try {
      const name = project.metadata.project_name || state.modelName || 'project';
      const opts = { grids: state.grids, lang, drawings };
      if (kind === 'pdf') await exportSheetSetPdf(project, name, opts);
      else await exportSheetSetDxf(project, name, opts);
    } catch (err) {
      console.error('Sheet export failed:', err);
      setError(t('sheets.exportFailed'));
    } finally {
      setBusy(null);
    }
  };

  const vp = set.viewports.find(v => v.id === selectedVp) ?? null;
  const placedOn = (spec: ViewSpec) => set.viewports
    .filter(v => v.type === spec.type && (spec.type === 'plan' ? v.levelId === spec.levelId : spec.type === 'schedule' ? v.schedule === spec.schedule : v.viewId === spec.viewId))
    .map(v => set.sheets.find(s => s.id === v.sheetId)?.number).filter(Boolean) as string[];

  if (!project) return null;
  const sections = project.sections ?? [];
  const levels = [...project.levels].sort((a, b) => a.elevation - b.elevation).filter(l => hasPlan(project, l.id));
  const palette: { group: string; items: { spec: ViewSpec; label: string; testId: string }[] }[] = [
    { group: t('sheets.plans'), items: levels.map(l => ({
      spec: { type: 'plan', levelId: l.id, viewId: '', schedule: '', discipline: 'architecture' },
      label: drawingLabel(lang, 'drawing.title.architecture', { level: l.name || l.id }), testId: `palette-plan-${l.id}`,
    })) },
    { group: t('sheets.sectionsElevations'), items: [
      ...sections.map(s => ({ spec: { type: 'section' as ViewportType, levelId: '', viewId: s.id, schedule: '', discipline: 'architecture' as DrawingDiscipline }, label: t('views.sectionOf', { name: s.name || s.id }), testId: `palette-section-${s.id}` })),
      ...ELEVATIONS.map(d => ({ spec: { type: 'elevation' as ViewportType, levelId: '', viewId: d, schedule: '', discipline: 'architecture' as DrawingDiscipline }, label: t('views.elevationOf', { dir: t(`views.dir.${d}`) }), testId: `palette-elevation-${d}` })),
    ] },
    { group: t('sheets.schedules'), items: SCHEDULES.map(c => ({
      spec: { type: 'schedule' as ViewportType, levelId: '', viewId: '', schedule: c.key, discipline: 'architecture' as DrawingDiscipline },
      label: t(c.label), testId: `palette-schedule-${c.key}`,
    })) },
    { group: t('sheets.other'), items: [{ spec: { type: 'legend', levelId: '', viewId: '', schedule: '', discipline: 'architecture' }, label: t('sheets.legendView'), testId: 'palette-legend' }] },
  ];

  return (
    <div data-testid="sheets-panel"
      className="absolute inset-3 z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-[var(--bg-canvas)] shadow-[var(--shadow-panel)] animate-in fade-in duration-150">
      {/* Header */}
      <div className="glass-panel flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <span className="mr-2 text-[12px] font-semibold">{t('sheets.title')}</span>
        {readonly && <span className="text-[10px] text-muted-foreground">{t('sheets.readonly')}</span>}
        <div className="ml-auto flex items-center gap-1">
          {error && <span className="text-[10px] text-destructive">{error}</span>}
          <button className={BTN} disabled={!set.sheets.length || !!busy} onClick={() => runExport('pdf')} data-testid="sheets-export-pdf">
            {busy === 'pdf' ? t('sheets.exporting') : t('sheets.exportPdf')}
          </button>
          <button className={BTN} disabled={!set.sheets.length || !!busy} onClick={() => runExport('dxf')} data-testid="sheets-export-dxf">
            {busy === 'dxf' ? t('sheets.exporting') : t('sheets.exportDxf')}
          </button>
          <button className={BTN} onClick={onClose} title={t('sheets.close')} data-testid="sheets-close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sheet list + project info */}
        <div className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border/60 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sheets.title')}</span>
            {!readonly && <button className={BTN} onClick={createSheet} data-testid="sheets-new">+ {t('sheets.new')}</button>}
          </div>
          {!set.sheets.length && <p className="px-1 text-[11px] text-muted-foreground">{t('sheets.empty')}</p>}
          <div className="flex flex-col gap-0.5" data-testid="sheet-list">
            {set.sheets.map(s => (
              <div key={s.id} className="group flex items-center">
                <button
                  className={cn('flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1 text-left text-[11px]',
                    s.id === sheet?.id ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]' : 'bg-transparent hover:bg-accent')}
                  onClick={() => { setCurrentId(s.id); setSelectedVp(null); }} data-testid={`sheet-${s.number}`}>
                  <span className="shrink-0 font-semibold tabular-nums">{s.number}</span>
                  <span className="truncate text-muted-foreground">{s.name}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{s.paper}</span>
                </button>
                {!readonly && (
                  <button className="ml-0.5 hidden size-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-muted-foreground hover:text-destructive group-hover:flex"
                    title={t('sheets.delete')} onClick={() => setConfirmDelete(s)}>×</button>
                )}
              </div>
            ))}
          </div>

          {sheet && (
            <div className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2" data-testid="sheet-props">
              <div className="grid grid-cols-[1fr_4.5rem] gap-1.5">
                <TextField label={t('sheets.number')} value={sheet.number} disabled={readonly} testId="sheet-number"
                  onCommit={v => v.trim() && !set.sheets.some(s => s.id !== sheet.id && s.number === v.trim()) && updateSheet({ number: v.trim() })} />
                <Field label={t('sheets.paper')}>
                  <select className={INPUT} value={sheet.paper} disabled={readonly} data-testid="sheet-paper"
                    onChange={e => updateSheet({ paper: e.target.value as SheetPaper })}>
                    {(Object.keys(SHEET_PAPERS) as SheetPaper[]).map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
              </div>
              <TextField label={t('sheets.name')} value={sheet.name} disabled={readonly} testId="sheet-name" onCommit={v => updateSheet({ name: v.trim() })} />
              <div className="grid grid-cols-[3rem_1fr] gap-1.5">
                <TextField label={t('sheets.revision')} value={sheet.revision} disabled={readonly} testId="sheet-revision" onCommit={v => updateSheet({ revision: v.trim() })} />
                <TextField label={t('sheets.revisionDate')} value={sheet.revisionDate} disabled={readonly} placeholder="YYYY-MM-DD" testId="sheet-revision-date"
                  onCommit={v => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) && updateSheet({ revisionDate: v.trim() })} />
              </div>
              <TextField label={t('sheets.revisionNote')} value={sheet.revisionNote} disabled={readonly} testId="sheet-revision-note" onCommit={v => updateSheet({ revisionNote: v.trim() })} />
              <TextField label={t('sheets.issueDate')} value={sheet.issueDate} disabled={readonly} placeholder="YYYY-MM-DD" hint={t('sheets.issueDateHint')} testId="sheet-issue-date"
                onCommit={v => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) && updateSheet({ issueDate: v.trim() })} />
              <div className="grid grid-cols-2 gap-1.5">
                <TextField label={t('sheets.drawnBy')} value={sheet.drawnBy} disabled={readonly} testId="sheet-drawn" onCommit={v => updateSheet({ drawnBy: v.trim() })} />
                <TextField label={t('sheets.checkedBy')} value={sheet.checkedBy} disabled={readonly} testId="sheet-checked" onCommit={v => updateSheet({ checkedBy: v.trim() })} />
              </div>
            </div>
          )}

          <div className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2" data-testid="project-info">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sheets.project')}</span>
            {(['project_name', 'project_number', 'client', 'address'] as const).map(key => (
              <TextField key={key} label={t(`sheets.${key === 'project_name' ? 'projectName' : key === 'project_number' ? 'projectNumber' : key}`)}
                value={project.metadata[key] ?? ''} disabled={readonly} testId={`meta-${key}`}
                onCommit={v => dispatch({ type: 'UPDATE_METADATA', fields: { [key]: v }, persist: true })} />
            ))}
          </div>
        </div>

        {/* Sheet canvas */}
        <div className="relative min-w-0 flex-1 bg-[#e9e9e9] dark:bg-[#2a2a2a]">
          {composed ? (
            <SheetCanvas
              composed={composed}
              selected={selectedVp}
              readonly={readonly}
              onSelect={setSelectedVp}
              onMove={(id, x, y) => updateVp(id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })}
              onDrop={(spec, x, y) => place(spec, x, y)}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">{t('sheets.empty')}</div>
          )}
        </div>

        {/* Views palette / viewport properties */}
        <div className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border/60 p-2">
          {vp && sheet ? (
            <div className="flex flex-col gap-1.5" data-testid="viewport-props">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sheets.viewport')}</span>
              <div className="text-[11px] font-medium">{composed?.viewports.find(p => p.vp.id === vp.id)?.title}</div>
              {(vp.type === 'plan' || vp.type === 'section' || vp.type === 'elevation') && (
                <Field label={t('sheets.scale')}>
                  <select className={INPUT} value={vp.scale} disabled={readonly} data-testid="viewport-scale"
                    onChange={e => updateVp(vp.id, { scale: parseInt(e.target.value, 10) })}>
                    {[...new Set([...SCALES, vp.scale])].sort((a, b) => a - b).map(s => <option key={s} value={s}>1:{s}</option>)}
                  </select>
                </Field>
              )}
              {vp.type === 'plan' && (
                <Field label={t('sheets.discipline')}>
                  <select className={INPUT} value={vp.discipline} disabled={readonly} data-testid="viewport-discipline"
                    onChange={e => updateVp(vp.id, { discipline: e.target.value as DrawingDiscipline })}>
                    {DISCIPLINES.map(d => <option key={d} value={d}>{t(`sheets.discipline.${d}`)}</option>)}
                  </select>
                </Field>
              )}
              {composed?.outside.includes(vp.id) && (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400" data-testid="viewport-outside">
                  {t('sheets.vpOutside')}
                </div>
              )}
              {(vp.type === 'plan' || vp.type === 'section' || vp.type === 'elevation') && (
                <TextField label={t('sheets.crop')} hint={t('sheets.cropHint')} testId="viewport-crop" disabled={readonly}
                  value={vp.crop ? [vp.crop.minX, vp.crop.minY, vp.crop.maxX, vp.crop.maxY].map(n => String(Math.round(n * 1000) / 1000)).join(', ') : ''}
                  placeholder={(() => {
                    const b = composed?.viewports.find(p => p.vp.id === vp.id)?.drawing?.bounds;
                    return b ? [b.minX, b.minY, b.maxX, b.maxY].map(n => String(Math.round(n * 10) / 10)).join(', ') : '';
                  })()}
                  onCommit={v => {
                    const n = v.split(/[,;\s]+/).filter(Boolean).map(Number);
                    if (v.trim() === '') updateVp(vp.id, { crop: undefined });
                    else if (n.length === 4 && n.every(Number.isFinite) && n[2] > n[0] && n[3] > n[1]) updateVp(vp.id, { crop: { minX: n[0], minY: n[1], maxX: n[2], maxY: n[3] } });
                  }} />
              )}
              <TextField label={t('sheets.vpTitle')} value={vp.title} disabled={readonly} hint={t('sheets.vpTitleHint')} testId="viewport-title"
                placeholder={composed?.viewports.find(p => p.vp.id === vp.id)?.title}
                onCommit={v => updateVp(vp.id, { title: v.trim() })} />
              {!readonly && (
                <button className={cn(BTN, 'justify-center text-destructive hover:text-destructive')} onClick={() => removeVp(vp.id)} data-testid="viewport-remove">
                  {t('sheets.removeViewport')}
                </button>
              )}
              <button className={cn(BTN, 'justify-center')} onClick={() => setSelectedVp(null)}>{t('sheets.views')} →</button>
            </div>
          ) : (
            <>
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sheets.views')}</span>
                <p className="text-[10px] text-muted-foreground">{t('sheets.viewsHint')}</p>
              </div>
              {palette.map(g => (
                <div key={g.group} className="flex flex-col gap-0.5">
                  <span className="px-1 text-[10px] font-medium text-muted-foreground">{g.group}</span>
                  {g.items.map(it => {
                    const on = placedOn(it.spec);
                    return (
                      <div key={it.testId} draggable={!readonly && !!sheet} data-testid={it.testId}
                        onDragStart={e => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify(it.spec)); e.dataTransfer.effectAllowed = 'copy'; }}
                        onDoubleClick={() => { if (sheet) { const F = sheetFrame(sheet.paper); place(it.spec, F.area.x + F.area.w / 2, F.area.y + F.area.h / 2); } }}
                        className={cn('flex cursor-grab items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-[11px] hover:border-border hover:bg-accent active:cursor-grabbing',
                          (readonly || !sheet) && 'cursor-default opacity-60')}>
                        <span className="truncate">{it.label}</span>
                        {on.length > 0 && <span className="ml-auto shrink-0 rounded bg-[var(--accent-dim)] px-1 text-[9px] text-[var(--color-accent)]">{on.join(', ')}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog title={t('sheets.delete')} message={t('sheets.deleteConfirm', { number: confirmDelete.number })}
          confirmLabel={t('sheets.delete')} danger onConfirm={() => deleteSheet(confirmDelete)} onClose={() => setConfirmDelete(null)} />
      )}
    </div>
  );
}

// ─── Canvas ─────────────────────────────────────────────────────────────────

interface CanvasProps {
  composed: ReturnType<typeof composeSheet>;
  selected: string | null;
  readonly: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onDrop: (spec: ViewSpec, x: number, y: number) => void;
}

/** The sheet at paper proportions: zoom with the wheel, pan by dragging the background, drag viewports to move them. */
function SheetCanvas({ composed, selected, readonly, onSelect, onMove, onDrop }: CanvasProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const { w: PW, h: PH } = composed.frame.paper;
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const gesture = useRef<{ kind: 'pan' | 'move'; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const zoom = Math.min((width - 32) / PW, (height - 32) / PH);
    setView({ zoom, x: (width - PW * zoom) / 2, y: (height - PH * zoom) / 2 });
  }, [PW, PH]);
  useEffect(() => { fit(); }, [fit, composed.sheet.id]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /** Client point → paper mm (Y up). */
  const toPaper = (cx: number, cy: number) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.zoom, y: PH - (cy - r.top - view.y) / view.zoom };
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * 0.0015);
    const zoom = Math.max(0.2, Math.min(40, view.zoom * k));
    const px = e.clientX - r.left, py = e.clientY - r.top;
    setView({ zoom, x: px - (px - view.x) * (zoom / view.zoom), y: py - (py - view.y) * (zoom / view.zoom) });
  };

  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (id && e.button === 0) {
      onSelect(id);
      gesture.current = { kind: 'move', id, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
    } else {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.hypot(dx, dy) > 3) g.moved = true;
    if (g.kind === 'pan') setView(v => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
    else if (!readonly && g.moved) setDrag({ id: g.id!, dx: dx / view.zoom, dy: -dy / view.zoom });
  };
  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === 'pan' && !g.moved) onSelect(null);
    if (g.kind === 'move' && drag && g.moved && !readonly) {
      const vp = composed.viewports.find(v => v.vp.id === drag.id)?.vp;
      if (vp) onMove(vp.id, vp.x + drag.dx, vp.y + drag.dy);
    }
    setDrag(null);
  };

  const renderViewport = (pv: PlacedViewport) => {
    const off = drag?.id === pv.vp.id ? drag : { dx: 0, dy: 0 };
    const sel = selected === pv.vp.id;
    const r = pv.rect;
    return (
      <g key={pv.vp.id} transform={`translate(${off.dx},${off.dy})`} data-testid={`viewport-${pv.vp.id}`}>
        {pv.drawing && pv.transform && (
          <g transform={`translate(${pv.transform.at.x},${pv.transform.at.y}) scale(${1 / pv.transform.pm}) translate(${-pv.transform.center.x},${-pv.transform.center.y})`}>
            <DrawingItemsSvg items={pv.drawing.items} layers={pv.drawing.layers} pm={pv.drawing.pm} />
          </g>
        )}
        <DrawingItemsSvg items={pv.paperItems} layers={pv.paperLayers} pm={1} />
        <DrawingItemsSvg items={pv.titleItems} layers={pv.paperLayers} pm={1} />
        <rect x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4}
          fill="rgba(58,123,255,0.001)" stroke={sel ? '#3a7bff' : composed.outside.includes(pv.vp.id) ? '#d97706' : 'transparent'} strokeWidth={0.6} strokeDasharray="3 2"
          className={readonly ? 'cursor-pointer' : 'cursor-move'}
          onPointerDown={e => onPointerDown(e, pv.vp.id)} />
      </g>
    );
  };

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden" data-testid="sheet-canvas"
      onWheel={onWheel}
      onPointerDown={e => onPointerDown(e)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onDragOver={e => { if (!readonly && e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={e => {
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (!raw || readonly) return;
        e.preventDefault();
        const p = toPaper(e.clientX, e.clientY);
        onDrop(JSON.parse(raw) as ViewSpec, p.x, p.y);
      }}>
      <svg width="100%" height="100%" className="block select-none">
        <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
          <rect x={0.8} y={0.8} width={PW} height={PH} fill="rgba(0,0,0,0.12)" />
          <rect x={0} y={0} width={PW} height={PH} fill="#ffffff" />
          <g transform={`translate(0,${PH}) scale(1,-1)`}>
            <DrawingItemsSvg items={composed.items} layers={composed.layers} pm={1} />
            {composed.viewports.map(renderViewport)}
          </g>
        </g>
      </svg>
      <button className="glass-panel absolute bottom-2 right-2 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={fit} data-testid="sheet-fit">{t('sheets.zoomFit')}</button>
    </div>
  );
}
