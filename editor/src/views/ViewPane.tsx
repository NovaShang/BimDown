import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ElevationDir, SectionDef } from './viewTypes.ts';
import { cn } from '../lib/utils';

const OrthoView = lazy(() => import('./OrthoView.tsx'));
const ViewDrawing = lazy(() => import('./ViewDrawing.tsx'));

const DIRS: ElevationDir[] = ['north', 'south', 'east', 'west'];

const BTN = 'flex h-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/** Docked pane (right side of the canvas) showing the open elevation or section. */
export default function ViewPane() {
  const { t } = useTranslation();
  const { views, project, readonly } = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const [width, setWidth] = useState(() => Math.round(Math.min(720, Math.max(380, window.innerWidth * 0.42))));
  const resize = useRef<{ x: number; w: number } | null>(null);
  // 3D (interactive ortho model) or 2D drawing (vector line work + annotations)
  const [mode, setMode] = useState<'3d' | 'drawing'>('3d');
  const open = views.open;
  if (!open) return null;

  const sections = project?.sections ?? [];
  const section = open.kind === 'section' ? sections.find(s => s.id === open.id) : undefined;
  if (open.kind === 'section' && !section) return null;

  const updateSection = (next: SectionDef) => {
    dispatch({ type: 'UPDATE_SECTIONS', sections: sections.map(s => s.id === next.id ? next : s), persist: true });
  };
  const title = open.kind === 'elevation'
    ? t('views.elevationOf', { dir: t(`views.dir.${open.dir}`) })
    : t('views.sectionOf', { name: section!.name || section!.id });

  return (
    <div
      data-testid="view-pane"
      className={cn(
        'absolute top-16 z-30 flex flex-col overflow-hidden rounded-2xl border border-[var(--panel-border)] bg-[var(--bg-canvas)] shadow-[var(--shadow-panel)]',
        // Stay clear of the bottom tool bar (bottom-3, ~57 px tall) when editing; the view bar alone when read-only
        readonly ? 'bottom-[52px]' : 'bottom-[80px]',
        views.paneMaximized ? 'left-3 right-3' : 'right-3',
      )}
      style={views.paneMaximized ? undefined : { width }}
    >
      {!views.paneMaximized && (
        <div
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize hover:bg-[var(--accent-dim)]"
          onPointerDown={e => { resize.current = { x: e.clientX, w: width }; (e.target as Element).setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (resize.current) setWidth(Math.max(300, resize.current.w - (e.clientX - resize.current.x))); }}
          onPointerUp={() => { resize.current = null; }}
        />
      )}
      <div className="glass-panel flex shrink-0 items-center gap-1 border-b border-[var(--panel-border)] px-2 py-1">
        <span className="truncate px-1 text-[11px] font-semibold" data-testid="view-pane-title">{title}</span>
        {open.kind === 'elevation' && (
          <div className="ml-1 flex items-center gap-0.5">
            {DIRS.map(d => (
              <button key={d} className={cn(BTN, 'w-7 font-semibold', open.dir === d && 'bg-[var(--accent-dim)] text-[var(--color-accent)]')}
                title={t(`views.dir.${d}`)}
                onClick={() => dispatch({ type: 'OPEN_VIEW', view: { kind: 'elevation', dir: d } })}>
                {t(`views.dirShort.${d}`)}
              </button>
            ))}
          </div>
        )}
        {section && !readonly && (
          <div className="ml-1 flex items-center gap-1">
            <input
              key={section.id}
              className="h-6 w-16 rounded-md border border-transparent bg-transparent px-1 text-[11px] hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)]"
              defaultValue={section.name}
              title={t('views.sectionName')}
              onBlur={e => { const name = e.target.value.trim(); if (name !== section.name) updateSection({ ...section, name }); }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            <label className="flex items-center gap-0.5 text-[10px] text-muted-foreground" title={t('views.depthTitle')}>
              {t('views.depth')}
              <input
                key={`${section.id}-depth`}
                type="number" min={0} step={0.5}
                className="h-6 w-12 rounded-md border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)]"
                defaultValue={section.depth ?? ''}
                placeholder="∞"
                onBlur={e => {
                  const v = parseFloat(e.target.value);
                  const depth = Number.isFinite(v) && v > 0 ? v : undefined;
                  if (depth !== section.depth) updateSection({ ...section, depth });
                }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            </label>
            <button className={BTN} title={t('views.flip')}
              onClick={() => updateSection({ ...section, start: section.end, end: section.start })}>
              ⇄
            </button>
          </div>
        )}
        <div className="ml-2 flex items-center rounded-md border border-border p-0.5" title={t('views.modeTitle')}>
          {(['3d', 'drawing'] as const).map(m => (
            <button key={m} className={cn('h-5 cursor-pointer rounded border-none px-1.5 text-[10px]', mode === m ? 'bg-[var(--accent-dim)] text-[var(--color-accent)]' : 'bg-transparent text-muted-foreground')}
              data-testid={`view-mode-${m}`} onClick={() => setMode(m)}>
              {t(m === '3d' ? 'views.mode3d' : 'views.modeDrawing')}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <button className={BTN} title={t('view.zoomToFit')} onClick={() => window.dispatchEvent(new Event('zoom-to-fit-view'))}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" /></svg>
          </button>
          <button className={BTN} title={t(views.paneMaximized ? 'views.restore' : 'views.maximize')} onClick={() => dispatch({ type: 'TOGGLE_VIEW_PANE_MAX' })}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              {views.paneMaximized ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />}
            </svg>
          </button>
          <button className={BTN} title={t('views.close')} data-testid="view-pane-close" onClick={() => dispatch({ type: 'OPEN_VIEW', view: null })}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={null}>
          {mode === 'drawing'
            ? <ViewDrawing view={open.kind === 'elevation' ? { kind: 'elevation', id: open.dir } : { kind: 'section', id: open.id }} />
            : <OrthoView view={open} />}
        </Suspense>
      </div>
    </div>
  );
}
