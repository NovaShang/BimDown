import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import { elementBounds } from '../schedule/quantities.ts';
import { parseFloorLayers } from '../model/parse.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { metre } from '../annotation/geometry.ts';
import { projectWarnings, type ModelWarning, type WarningKind } from '../warnings/modelWarnings.ts';
import { ZOOM_TO_EVENT } from './SchedulePanel.tsx';
import { toElementId } from '../model/ids.ts';
import { cn } from '../lib/utils';

/** Event a host app (or the top bar) fires to open/close the warnings panel. */
export const WARNINGS_TOGGLE_EVENT = 'bimdown:toggle-warnings';

/** The elements a row selects: a redundant room alone (its properties show the warning), else all involved. */
const selectIds = (w: ModelWarning) => (w.kind === 'redundant_room' ? [w.ids[0]] : w.ids);

const KIND_ORDER: WarningKind[] = ['insert_overlap', 'wall_overlap', 'redundant_room', 'unbounded_room', 'stair', 'duplicate_number', 'mep'];

/**
 * Live project warnings (warnings/modelWarnings.ts), recomputed shortly after
 * the model settles so typing and dragging stay smooth.
 */
export function useModelWarnings(state: EditorState): ModelWarning[] {
  const warnings = useSyncExternalStore(subscribe, () => current);
  const { project, document: doc } = state;
  useEffect(() => {
    if (!project) { publish([]); return; }
    const timer = setTimeout(() => {
      try {
        publish(projectWarnings(project, metre(), doc?.levelId, doc?.elements));
      } catch (e) {
        console.warn('[warnings] check failed', e);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [project, doc, state.documentVersion]);
  return warnings;
}

// The latest warnings, shared with the properties panel (one computation, in the editor shell).
let current: ModelWarning[] = [];
const listeners = new Set<() => void>();
function publish(w: ModelWarning[]) {
  current = w;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// Plan markers are on while the warnings panel is open.
let markersOn = false;
function setMarkersOn(v: boolean) {
  markersOn = v;
  for (const l of listeners) l();
}

/** Where a warning sits in plan: its own point, else the middle of its elements. */
export function warningPoint(w: ModelWarning, elements: ReadonlyMap<string, CanonicalElement> | undefined): { x: number; y: number } | null {
  if (w.at) return w.at;
  let n = 0, x = 0, y = 0;
  for (const id of w.ids) {
    const el = elements?.get(id);
    if (!el) continue;
    const b = elementBounds(el);
    x += (b.minX + b.maxX) / 2; y += (b.minY + b.maxY) / 2; n++;
  }
  return n ? { x: x / n, y: y / n } : null;
}

/** Warning markers on the plan of the open level (SVG, model coordinates; ~10 px on screen via `scale`). */
export function WarningMarkers2D({ scale }: { scale: number }) {
  const all = useSyncExternalStore(subscribe, () => current);
  const on = useSyncExternalStore(subscribe, () => markersOn);
  const state = useEditorState();
  const doc = state.document;
  if (!on || !doc) return null;
  const r = 10 / (15 * Math.max(scale, 1e-3));
  const marks = all.filter(w => w.levelId === doc.levelId).map(w => ({ w, p: warningPoint(w, doc.elements) })).filter(m => m.p);
  if (marks.length === 0) return null;
  return (
    <g pointerEvents="none" transform="scale(1,-1)" data-testid="warning-markers">
      {marks.map(({ w, p }) => {
        // Same frame as the clash markers: model y up inside the flipped group
        const { x, y } = p!;
        return (
          <g key={w.key}>
            <path d={`M ${x} ${y + r} L ${x + r * 0.95} ${y - r * 0.7} L ${x - r * 0.95} ${y - r * 0.7} Z`} fill="#f59e0b" fillOpacity={0.25} stroke="#d97706" strokeWidth={r * 0.18} />
            <line x1={x} y1={y + r * 0.45} x2={x} y2={y - r * 0.15} stroke="#b45309" strokeWidth={r * 0.2} />
            <circle cx={x} cy={y - r * 0.42} r={r * 0.11} fill="#b45309" />
          </g>
        );
      })}
    </g>
  );
}

/** The selected element's warnings, shown at the top of the properties panel. */
export function ElementWarnings({ id }: { id: string }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const all = useSyncExternalStore(subscribe, () => current);
  const raw = toElementId(id);
  const mine = all.filter(w => w.levelId === state.currentLevel && w.ids.includes(raw));
  if (mine.length === 0) return null;
  const text = (w: ModelWarning) => (w.kind === 'redundant_room' && w.ids[0] === raw
    ? t('warnings.room', { other: w.params.other })
    : w.kind === 'unbounded_room' ? t('warnings.roomUnbounded')
    : t(w.text, w.kind === 'mep' ? { ...w.params, problem: t(`mep.problem.${w.params.code}`) } : w.params));
  return (
    <div className="mx-3 my-1.5 flex flex-col gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1" data-testid="element-warnings">
      {mine.map(w => (
        <div key={w.key} className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <WarnIcon className="mt-[1px] size-3 shrink-0" />
          <span>{text(w)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Warnings panel (Revit "Review Warnings"): every level's model warnings
 * grouped by kind; a row click selects the elements and zooms to them,
 * switching level when needed.
 */
export default function WarningsPanel({ warnings, onClose }: { warnings: ModelWarning[]; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => { setMarkersOn(true); return () => setMarkersOn(false); }, []);
  const levelName = (id: string) => {
    const l = state.project?.levels.find(x => x.id === id);
    return l ? (l.name || l.number || l.id) : id;
  };
  const groups = useMemo(() => {
    const m = new Map<WarningKind, ModelWarning[]>();
    for (const w of warnings) {
      const list = m.get(w.kind);
      if (list) list.push(w);
      else m.set(w.kind, [w]);
    }
    return KIND_ORDER.filter(k => m.has(k)).map(k => ({ kind: k, rows: m.get(k)! }));
  }, [warnings]);

  // Zoom after a level switch, once the new level's document is in
  const pending = useRef<ModelWarning | null>(null);
  const zoomTo = (w: ModelWarning, elements: ReadonlyMap<string, CanonicalElement> | undefined) => {
    let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    const grow = (b: { minX: number; minY: number; maxX: number; maxY: number }) => {
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
    };
    for (const id of w.ids) {
      const el = elements?.get(id);
      if (el) grow(elementBounds(el));
    }
    if (w.at) grow({ minX: w.at.x, minY: w.at.y, maxX: w.at.x, maxY: w.at.y });
    if (!box) return;
    const b = box as { minX: number; minY: number; maxX: number; maxY: number };
    const pad = 2.5 * metre();
    window.dispatchEvent(new CustomEvent(ZOOM_TO_EVENT, { detail: { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad } }));
  };
  useEffect(() => {
    const w = pending.current;
    if (!w || state.document?.levelId !== w.levelId) return;
    pending.current = null;
    dispatch({ type: 'SELECT', ids: selectIds(w).filter(id => state.document!.elements.has(id)).map(id => `${w.levelId}:${id}`) });
    zoomTo(w, state.document.elements);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.document]);

  const open = (w: ModelWarning) => {
    if (w.levelId !== state.currentLevel) {
      pending.current = w;
      dispatch({ type: 'SET_LEVEL', levelId: w.levelId });
      // Fallback when the document doesn't change identity (view-only projects)
      setTimeout(() => {
        if (pending.current !== w) return;
        pending.current = null;
        const floor = state.project?.floors.get(w.levelId);
        if (floor) zoomTo(w, new Map(parseFloorLayers(floor.layers).map(e => [e.id, e])));
      }, 120);
      return;
    }
    dispatch({ type: 'SELECT', ids: selectIds(w).filter(id => state.document?.elements.has(id) ?? true).map(id => `${w.levelId}:${id}`) });
    zoomTo(w, state.document?.elements);
  };

  const toggle = (k: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const text = (w: ModelWarning) => {
    const params = w.kind === 'mep' ? { ...w.params, problem: t(`mep.problem.${w.params.code}`) } : w.params;
    return t(w.text, params);
  };

  return (
    <div data-testid="warnings-panel" data-canvas-overlay="right"
      className="absolute right-3 top-16 z-40 flex max-h-[60%] w-[360px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden glass-panel rounded-xl border border-border shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <WarnIcon className="text-amber-500" />
        <span className="flex-1 text-[11px] font-semibold">{t('warnings.title')}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{t('warnings.count', { count: warnings.length })}</span>
        <button className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose} title={t('warnings.close')} data-testid="warnings-close">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {warnings.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-emerald-600" data-testid="warnings-clean">{t('warnings.none')}</div>
        ) : groups.map(g => (
          <div key={g.kind} data-kind={g.kind}>
            <button className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
              onClick={() => toggle(g.kind)}>
              <span className="w-2.5">{collapsed.has(g.kind) ? '▸' : '▾'}</span>
              <span className="flex-1">{t(`warnings.kind.${g.kind}`)}</span>
              <span className="tabular-nums">{g.rows.length}</span>
            </button>
            {!collapsed.has(g.kind) && g.rows.map(w => (
              <button key={w.key} data-testid="warning-row"
                className={cn('flex w-full items-start gap-1.5 px-2.5 py-1 pl-6 text-left text-[11px] hover:bg-accent',
                  w.ids.some(id => state.selectedIds.has(`${w.levelId}:${id}`)) && 'bg-[var(--accent-dim)]')}
                onClick={() => open(w)} title={t('warnings.zoomTip')}>
                <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-amber-500" />
                <span className="min-w-0 flex-1">{text(w)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{levelName(w.levelId)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WarnIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className={className}>
      <path d="M8 1.8 15 14H1z" /><path d="M8 6v4M8 11.6v.4" strokeLinecap="round" />
    </svg>
  );
}
