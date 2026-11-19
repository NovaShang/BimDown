/**
 * MEP panel, Clash tab: on-demand clash detection for the open level (its MEP
 * against its structure, walls, other MEP and the slab / framing of the level
 * above). Rows are grouped by severity; a click selects both elements, zooms
 * the plan to the clash and, in 3D, puts a section box around it and frames it.
 * Overlaps within the tolerance (modelling slack) are a collapsed "minor"
 * group, hidden by default. Tolerance / clearance are kept per project.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { toSelectionId } from '../model/ids.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { cn } from '../lib/utils.ts';
import { detectClashes, clashCounts, type Clash, type ClashSeverity } from './clash.ts';
import { buildClashModel } from './clashModel.ts';
import { clashSectionBox, loadClashSettings, saveClashSettings, setClashView, useClashView, zoomPlanTo, SEVERITY_COLOR } from './clashView.tsx';

const btn = 'cursor-pointer rounded border border-border bg-transparent px-1.5 py-[1px] text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40';
const input = 'h-5 w-12 rounded border border-input bg-transparent px-1 text-right text-[10px] tabular-nums';
const SEVERITIES: ClashSeverity[] = ['high', 'medium', 'low'];

export default function ClashTab() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const view = useClashView();
  const model = state.modelName;
  const [settings, setSettings] = useState(() => ({ model, ...loadClashSettings(model) }));
  // Another project opened in this editor: its own settings.
  if (settings.model !== model) setSettings({ model, ...loadClashSettings(model) });
  const { tolerance, clearance } = settings;
  const update = (patch: Partial<{ tolerance: string; clearance: string }>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveClashSettings(model, { tolerance: next.tolerance, clearance: next.clearance });
  };
  const elements = state.document?.elements;
  const level = state.currentLevel;
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const elevation = state.project?.levels.find(l => l.id === level)?.elevation ?? 0;
  const clashes = view.level === level ? view.clashes : null;
  const stale = !!clashes && view.source !== elements;

  const run = () => {
    if (!elements) return;
    const mm = (s: string) => Math.max(0, parseFloat(s) || 0) / 1000 * upm;
    const clashModel = buildClashModel(elements, { project: state.project, levelId: level, unitsPerMetre: upm });
    const found = detectClashes(clashModel, { tolerance: mm(tolerance), clearance: mm(clearance), minor: true });
    setClashView({ level, source: elements, clashes: found, toleranceMm: Math.max(0, parseFloat(tolerance) || 0), active: null, showMarkers: true });
  };

  const pick = (c: Clash, i: number) => {
    // Elements of the level above can't be selected from this level.
    const ids = [c.aScope === undefined ? c.a : null, c.bScope === undefined ? c.b : null].filter((x): x is string => !!x);
    dispatch({ type: 'SELECT', ids: ids.map(id => (level ? toSelectionId(level, id) : id)) });
    setClashView({ active: i });
    zoomPlanTo(c.at, 3 * upm);
    if (state.viewMode === '3d') {
      // Like Revit's selection box: a section box around the clash, then frame it.
      dispatch({ type: 'SET_SECTION_BOX', enabled: true, bounds: clashSectionBox(c.at, elevation, 3 * upm, 2 * upm, 0.6 * upm) });
      setTimeout(() => window.dispatchEvent(new Event('zoom-to-fit-3d')), 50);
    }
  };

  const counts = clashes ? clashCounts(clashes) : null;
  const minorCount = clashes ? clashes.filter(c => c.minor).length : 0;
  const hard = clashes ? clashes.length - minorCount : 0;
  const mmOf = (v: number) => Math.round((v / upm) * 1000);
  const label = (table: string, id: string, scope?: string) => `${t(`layer.${table}`)} ${id}${scope ? ` (${t('mep.clash.above')})` : ''}`;

  const row = (c: Clash, i: number) => (
    <button key={i} type="button" onClick={() => pick(c, i)} data-testid="clash-row"
      className={cn('flex cursor-pointer flex-col items-stretch rounded border-none bg-transparent px-1.5 py-[2px] text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground',
        view.active === i && 'bg-accent text-foreground')}>
      <span className="truncate">
        <span className="font-semibold text-foreground">{label(c.aTable, c.a, c.aScope)}</span>
        <span className="px-1 opacity-60">×</span>
        <span className="font-semibold text-foreground">{label(c.bTable, c.b, c.bScope)}</span>
      </span>
      <span className="flex gap-1.5 tabular-nums opacity-80">
        <span>{t(`mep.clash.kind.${c.kind}`)}</span>
        <span>{c.kind === 'clearance' ? t('mep.clash.gap', { mm: mmOf(c.depth) }) : t('mep.clash.depth', { mm: mmOf(c.depth) })}</span>
        {c.systems.length > 0 && <span className="truncate">{c.systems.join(', ')}</span>}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-1" data-testid="mep-clash-tab">
      <div className="flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <label className="flex items-center gap-1" title={t('mep.clash.toleranceTip')}>
          {t('mep.clash.tolerance')}
          <input className={input} value={tolerance} inputMode="decimal" onChange={e => update({ tolerance: e.target.value })} data-testid="clash-tolerance" />
        </label>
        <label className="flex items-center gap-1" title={t('mep.clash.clearanceTip')}>
          {t('mep.clash.clearance')}
          <input className={input} value={clearance} inputMode="decimal" onChange={e => update({ clearance: e.target.value })} data-testid="clash-clearance" />
        </label>
        <button type="button" className={cn(btn, 'ml-auto font-semibold text-foreground')} onClick={run} disabled={!elements} data-testid="clash-run">
          {clashes ? t('mep.clash.rerun') : t('mep.clash.run')}
        </button>
      </div>
      {clashes && (
        <label className="flex cursor-pointer items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={view.showMarkers} onChange={e => setClashView({ showMarkers: e.target.checked })} />
          {t('mep.clash.markers')}
          {stale && <span className="ml-auto text-amber-600">{t('mep.clash.stale')}</span>}
        </label>
      )}
      {!clashes && <div className="px-2 py-2 text-center text-[10px] text-muted-foreground/70">{t('mep.clash.hint')}</div>}
      {clashes && hard === 0 && (
        <div className="px-2 py-2 text-center text-[10px] text-emerald-600" data-testid="clash-clean">{t('mep.clash.clean')}</div>
      )}
      {clashes && counts && SEVERITIES.filter(s => counts[s] > 0).map(sev => (
        <div key={sev} className="flex flex-col gap-px" data-testid={`clash-group-${sev}`}>
          <div className="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: SEVERITY_COLOR[sev] }}>
            <span className="size-2 rounded-full" style={{ backgroundColor: SEVERITY_COLOR[sev] }} />
            {t(`mep.clash.severity.${sev}`)} ({counts[sev]})
          </div>
          {clashes.map((c, i) => c.minor || c.severity !== sev ? null : row(c, i))}
        </div>
      ))}
      {clashes && minorCount > 0 && (
        <div className="flex flex-col gap-px" data-testid="clash-group-minor">
          <button type="button" onClick={() => setClashView({ showMinor: !view.showMinor })} title={t('mep.clash.minorTip')} aria-expanded={view.showMinor}
            className="flex cursor-pointer items-center gap-1.5 border-none bg-transparent px-1 pt-1 text-left text-[10px] font-semibold text-muted-foreground hover:text-foreground"
            data-testid="clash-minor-toggle">
            <span className="w-2 text-center">{view.showMinor ? '▾' : '▸'}</span>
            {t('mep.clash.minor', { n: minorCount, mm: view.toleranceMm })}
          </button>
          {view.showMinor && clashes.map((c, i) => c.minor ? row(c, i) : null)}
        </div>
      )}
    </div>
  );
}
