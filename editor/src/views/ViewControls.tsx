/**
 * View toolbar additions: the Views menu (elevations, sections, new section),
 * the plan view-range popover (cut height, overhead style, RCP) and the 3D
 * section-box buttons.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { Separator } from '../components/ui/separator';
import { cn } from '../lib/utils';
import { DEFAULT_CUT_HEIGHT, type ElevationDir } from './viewTypes.ts';

const ICON_BTN = 'flex size-8 cursor-pointer items-center justify-center rounded-lg border-none transition-all';
const idle = 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground';
const active = 'bg-[var(--accent-dim)] text-[var(--color-accent)]';
const ROW = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40';

function Popover({ label, icon, on, testId, children }: { label: string; icon: ReactNode; on?: boolean; testId: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Tooltip>
        <TooltipTrigger className={cn(ICON_BTN, open || on ? active : idle)} onClick={() => setOpen(o => !o)} data-testid={testId}>
          {icon}
        </TooltipTrigger>
        {!open && <TooltipContent side="top">{label}</TooltipContent>}
      </Tooltip>
      {open && (
        <div className="glass-panel absolute bottom-full left-0 mb-2 min-w-[190px] rounded-xl border border-border p-1.5 shadow-[var(--shadow-panel)]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <div className="px-2 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
);

const DIRS: ElevationDir[] = ['north', 'south', 'east', 'west'];

function ViewsMenu() {
  const { t } = useTranslation();
  const { project, viewMode, readonly, views } = useEditorState();
  const dispatch = useEditorDispatch();
  const sections = project?.sections ?? [];
  return (
    <Popover
      label={t('views.menu')}
      testId="views-menu"
      on={!!views.open}
      icon={(
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <path d="M2 13.5h12" /><path d="M3.5 13.5V6l4.5-3 4.5 3v7.5" /><path d="M6.5 13.5v-3h3v3" />
        </svg>
      )}
    >
      {close => (
        <>
          <Heading>{t('views.elevations')}</Heading>
          <div className="grid grid-cols-4 gap-0.5 px-1 pb-1">
            {DIRS.map(d => (
              <button key={d} data-testid={`elevation-${d}`}
                className={cn('h-7 cursor-pointer rounded-md border-none text-[11px] font-semibold',
                  views.open?.kind === 'elevation' && views.open.dir === d ? active : 'bg-transparent hover:bg-accent')}
                title={t(`views.dir.${d}`)}
                onClick={() => { dispatch({ type: 'OPEN_VIEW', view: { kind: 'elevation', dir: d } }); close(); }}>
                {t(`views.dirShort.${d}`)}
              </button>
            ))}
          </div>
          <Heading>{t('views.sections')}</Heading>
          {sections.length === 0 && <div className="px-2 py-1 text-[10px] text-muted-foreground">{t('views.noSections')}</div>}
          {sections.map(s => (
            <div key={s.id} className="group flex items-center">
              <button className={cn(ROW, views.open?.kind === 'section' && views.open.id === s.id && 'text-[var(--color-accent)]')}
                data-testid={`open-section-${s.id}`}
                onClick={() => { dispatch({ type: 'OPEN_VIEW', view: { kind: 'section', id: s.id } }); close(); }}>
                <span className="inline-flex size-4 items-center justify-center rounded-full border border-current text-[8px] font-bold">{(s.name || '?').slice(0, 2)}</span>
                {t('views.sectionOf', { name: s.name || s.id })}
              </button>
              {!readonly && (
                <button className="mr-1 hidden size-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-muted-foreground hover:text-destructive group-hover:flex"
                  title={t('views.deleteSection')}
                  onClick={() => dispatch({ type: 'UPDATE_SECTIONS', sections: sections.filter(x => x.id !== s.id), persist: true })}>
                  ×
                </button>
              )}
            </div>
          ))}
          {!readonly && (
            <button className={ROW} disabled={viewMode !== '2d'} data-testid="new-section"
              title={viewMode !== '2d' ? t('views.newSectionPlanOnly') : undefined}
              onClick={() => { dispatch({ type: 'SET_TOOL', tool: 'draw_section' }); close(); }}>
              <span className="inline-flex size-4 items-center justify-center text-[13px]">+</span>
              {t('views.newSection')}
            </button>
          )}
        </>
      )}
    </Popover>
  );
}

function ViewRangePopover() {
  const { t } = useTranslation();
  const { views, currentLevel, document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const cut = views.planCut[currentLevel] ?? DEFAULT_CUT_HEIGHT;
  const hasCeilings = !!doc && Array.from(doc.elements.values()).some(e => e.tableName === 'ceiling');
  return (
    <Popover
      label={t('views.viewRange')}
      testId="view-range"
      on={views.rcp}
      icon={(
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2 3h12" strokeDasharray="2 1.5" /><path d="M1.5 8.5h13" /><path d="M2 13h12" />
          <path d="M8 4.5v2.5M8 10v2" strokeWidth="1.1" />
        </svg>
      )}
    >
      {() => (
        <div className="flex flex-col gap-1.5 p-1">
          <label className="flex items-center justify-between gap-2 text-[11px]">
            <span>{t('views.cutHeight')}</span>
            <input
              key={currentLevel}
              data-testid="cut-height"
              type="number" step={0.1} min={0}
              className="h-6 w-16 rounded-md border border-border bg-[var(--bg-input)] px-1 text-right text-[11px] tabular-nums"
              defaultValue={cut}
              onChange={e => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v >= 0) dispatch({ type: 'SET_PLAN_CUT', levelId: currentLevel, height: v });
              }}
            />
          </label>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span>{t('views.aboveCut')}</span>
            <div className="flex rounded-md border border-border p-0.5">
              {(['dashed', 'hidden'] as const).map(style => (
                <button key={style} data-testid={`above-${style}`}
                  className={cn('h-5 cursor-pointer rounded border-none px-1.5 text-[10px]', views.aboveCut === style ? active : 'bg-transparent text-muted-foreground')}
                  onClick={() => dispatch({ type: 'SET_ABOVE_CUT_STYLE', style })}>
                  {t(`views.above.${style}`)}
                </button>
              ))}
            </div>
          </div>
          {(hasCeilings || views.rcp) && (
            <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px]" title={t('views.rcpTitle')}>
              <span>{t('views.rcp')}</span>
              <input type="checkbox" data-testid="rcp-toggle" checked={views.rcp} onChange={() => dispatch({ type: 'TOGGLE_RCP' })} />
            </label>
          )}
        </div>
      )}
    </Popover>
  );
}

function SectionBoxButtons() {
  const { t } = useTranslation();
  const { views, selectedIds } = useEditorState();
  const dispatch = useEditorDispatch();
  const on = views.sectionBox.enabled;
  return (
    <>
      <Tooltip>
        <TooltipTrigger className={cn(ICON_BTN, on ? active : idle)} data-testid="section-box-toggle"
          onClick={() => dispatch({ type: 'SET_SECTION_BOX', enabled: !on })}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
            <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" strokeDasharray="1.6 1.2" />
          </svg>
        </TooltipTrigger>
        <TooltipContent side="top">{t('views.sectionBox')}</TooltipContent>
      </Tooltip>
      {on && (
        <>
          <button className={cn('h-7 cursor-pointer rounded-md border-none px-1.5 text-[10px] font-medium disabled:cursor-default disabled:opacity-40', idle)}
            data-testid="section-box-fit" disabled={selectedIds.size === 0}
            onClick={() => window.dispatchEvent(new Event('section-box-fit'))}>
            {t('views.fitSelection')}
          </button>
          <button className={cn('h-7 cursor-pointer rounded-md border-none px-1.5 text-[10px] font-medium', idle)}
            data-testid="section-box-reset"
            onClick={() => window.dispatchEvent(new Event('section-box-reset'))}>
            {t('views.reset')}
          </button>
        </>
      )}
    </>
  );
}

/** Everything the view toolbar gains for views; rendered after its existing buttons. */
export default function ViewControls() {
  const { viewMode } = useEditorState();
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 self-stretch" />
      <ViewsMenu />
      {viewMode === '2d' ? <ViewRangePopover /> : <SectionBoxButtons />}
    </>
  );
}
