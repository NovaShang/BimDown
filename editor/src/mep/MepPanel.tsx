/**
 * MEP panel (left side, MEP discipline): system browser (members, length,
 * select / isolate / size), connectivity check (problem list + plan markers,
 * one-click cap), electrical circuits (create on a panel, assign the
 * selected devices, loads), and flow / size of the selected run.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCoreEditorState, useEditorDispatch, useSelectionState } from '../state/EditorContext.tsx';
import type { CanonicalElement, LineElement, PointElement, SpatialLineElement } from '../model/elements.ts';
import { toElementId, toSelectionId, generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { resolveMepSystemColor } from '../elements/_mepLineShared.tsx';
import { isMepLineTable } from '../model/mepTopology.ts';
import { endZ } from '../model/mepSplit.ts';
import { checkDocument, documentTrayFills, externalMep, systemRows, systemMemberIds } from './mepModel.ts';
import { setMepView, useMepView, UNASSIGNED, type ProblemMarker } from './mepView.ts';
import { computeRunFlows, runHydraulics, sizeDuct, sizePipe, sizeSystem } from './calc.ts';
import { balancePhases, circuitsIn, isPanel, newCircuit, panelLoads } from './circuits.ts';
import { loadScheduleSettings, saveScheduleSettings, SCHEDULE_TOGGLE_EVENT } from '../components/SchedulePanel.tsx';
import { PHASE_OPTIONS, type MepProblem, type TrayFill } from './mepCheck.ts';
import { cn } from '../lib/utils.ts';
import { reservedIds } from './reservedIds.ts';
import { transitionAtPort } from './transitions.ts';
import { panelLabel } from '../schedule/mepSchedules.ts';
import { drawingLang } from '../export/drawing/labels.ts';
import ClashTab from './ClashTab.tsx';
import { autoVent, type AutoVentResult } from './autoVent.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';

type Tab = 'systems' | 'check' | 'circuits' | 'clash';
type MepCurve = LineElement | SpatialLineElement;

const btn = 'shrink-0 whitespace-nowrap cursor-pointer rounded border border-border bg-transparent px-1.5 py-[1px] text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40';

export default function MepPanel() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const { selectedIds } = useSelectionState();
  const dispatch = useEditorDispatch();
  const view = useMepView();
  const [tab, setTab] = useState<Tab>('systems');
  const [deadEnds, setDeadEnds] = useState(true);
  const [vent, setVent] = useState<AutoVentResult | null>(null);
  const elements = state.document?.elements;
  const level = state.currentLevel;
  const readonly = state.readonly;
  const sel = (ids: string[]) => dispatch({ type: 'SELECT', ids: ids.map(id => level ? toSelectionId(level, id) : id) });

  const rows = useMemo(() => (elements ? systemRows(elements) : []), [elements]);
  const project = state.project;
  const ext = useMemo(() => externalMep(project, level), [project, level]);
  const problems = useMemo(() => (elements && (tab === 'check' || view.showProblems) ? checkDocument(elements, ext, { trayFillLimit: view.trayFillLimit }) : []),
    [elements, ext, tab, view.showProblems, view.trayFillLimit]);
  const fills = useMemo(() => (elements && tab === 'check' ? documentTrayFills(elements, view.trayFillLimit) : []), [elements, tab, view.trayFillLimit]);
  const warnings = problems.filter(p => p.severity === 'warning');

  // Problem markers follow the document while the check is on.
  useEffect(() => {
    if (!view.showProblems) return;
    const markers = new Map<string, ProblemMarker[]>();
    for (const p of problems) {
      if (!p.at) continue;
      const list = markers.get(p.id) ?? [];
      list.push({ x: p.at[0], y: p.at[1], severity: p.severity });
      markers.set(p.id, list);
    }
    setMepView({ problemMarkers: markers });
  }, [problems, view.showProblems]);

  if (!elements) return null;
  const systems = state.project?.mepSystems ?? [];
  const colorOf = (code: string) => (code === UNASSIGNED ? '#9ca3af' : resolveMepSystemColor(code, systems.find(s => s.system_type === code)?.color));

  return (
    <div className="glass-panel flex min-h-[6.5rem] shrink max-h-[40%] flex-col rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]" data-testid="mep-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-1 pt-2">
        {(['systems', 'check', 'circuits', 'clash'] as Tab[]).map(k => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={cn('shrink-0 cursor-pointer whitespace-nowrap rounded border-none px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.06em]',
              tab === k ? 'bg-accent text-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground')}>
            {t(`mep.tab.${k}`)}{k === 'check' && warnings.length > 0 ? ` (${warnings.length})` : ''}
          </button>
        ))}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground">
          <input type="checkbox" checked={view.showTags} onChange={e => setMepView({ showTags: e.target.checked })} />
          {t('mep.tags')}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tab === 'systems' && (
          <SystemsTab rows={rows} colorOf={colorOf} readonly={readonly} deadEnds={deadEnds} onDeadEnds={setDeadEnds} vent={vent}
            onVent={() => {
              // One undoable patch: tees on the drains and the stack, risers, branches
              const r = autoVent(elements, { levelId: level, upm: unitsPerMetreOf(getProjectUnits(state)) });
              if (r.patch.length) dispatch({ type: 'APPLY_PATCH', patches: new Map(r.patch.map(e => [e.id, e])), description: 'Auto vent' });
              setVent(r);
            }}
            onSelect={sys => sel(systemMemberIds(elements, sys))}
            onSize={sys => {
              const resized = sizeSystem(elements, sys, { deadEnds, levelId: level });
              if (resized.length) dispatch({ type: 'APPLY_PATCH', patches: new Map(resized.map(e => [e.id, e])), description: `Size ${sys}` });
            }} />
        )}
        {tab === 'check' && (
          <CheckTab problems={problems} fills={fills} readonly={readonly} onSelect={id => sel([id])}
            onDelete={p => dispatch({ type: 'DELETE_ELEMENTS', ids: [level ? toSelectionId(level, p.id) : p.id] })}
            onTransition={p => {
              const el = elements.get(p.id);
              if (!el || !isMepLineTable(el.tableName)) return;
              const ids = reservedIds(elements);
              for (const side of ['from', 'to'] as const) {
                const els = transitionAtPort(el as MepCurve, side, elements, ids, level);
                if (els) { dispatch({ type: 'APPLY_PATCH', patches: new Map(els.map(e => [e.id, e])), description: 'Add transition' }); return; }
              }
            }}
            onCap={p => {
              // One undoable patch (so it is saved as one change): the cap node and the run's ref to it.
              const el = elements.get(p.id);
              const cap = el ? capOpenEnd(el, elements, level) : null;
              if (!cap) {
                // The run ends on a fitting with nothing else: make that fitting the cap.
                const node = p.at && [...elements.values()].find(n => n.tableName === 'mep_node' && n.geometry === 'point'
                  && Math.hypot((n as PointElement).position.x - p.at![0], (n as PointElement).position.y - p.at![1]) < 0.01);
                if (node) dispatch({ type: 'UPDATE_ATTRS', id: node.id, attrs: { fitting: 'cap' } });
                return;
              }
              const curve = elements.get(cap.curveId)!;
              dispatch({ type: 'APPLY_PATCH', description: 'Cap open end', patches: new Map<string, CanonicalElement | null>([
                [cap.node.id, cap.node],
                [curve.id, { ...curve, attrs: { ...curve.attrs, [cap.side]: cap.node.id } }],
              ]) });
            }} />
        )}
        {tab === 'circuits' && (
          <CircuitsTab elements={elements} selectedIds={selectedIds} readonly={readonly} level={level}
            onCreate={c => dispatch({ type: 'CREATE_ELEMENTS', elements: [c], description: 'New circuit', selectPrimary: false })}
            onAssign={(ids, circuitId) => dispatch({ type: 'UPDATE_ATTRS_MANY', ids, attrs: { circuit_id: circuitId } })}
            onPatch={(attrsById, description) => {
              const patches = new Map<string, CanonicalElement>();
              for (const [id, attrs] of attrsById) {
                const el = elements.get(id);
                if (el) patches.set(id, { ...el, attrs: { ...el.attrs, ...attrs } });
              }
              if (patches.size) dispatch({ type: 'APPLY_PATCH', patches, description });
            }}
            onSchedule={() => {
              // Open the Schedule view on the panel schedule
              saveScheduleSettings(state.modelName, { ...loadScheduleSettings(state.modelName), catKey: 'panel' });
              window.dispatchEvent(new CustomEvent(SCHEDULE_TOGGLE_EVENT, { detail: { open: false } }));
              setTimeout(() => window.dispatchEvent(new CustomEvent(SCHEDULE_TOGGLE_EVENT, { detail: { open: true } })), 0);
            }} />
        )}
        {tab === 'clash' && <ClashTab />}
        <SelectedRun elements={elements} selectedIds={selectedIds} readonly={readonly}
          onApply={el => dispatch({ type: 'APPLY_PATCH', patches: new Map([[el.id, el]]), description: 'Apply suggested size' })} />
      </div>
    </div>
  );
}

function SystemsTab({ rows, colorOf, readonly, deadEnds, onDeadEnds, vent, onVent, onSelect, onSize }: {
  rows: ReturnType<typeof systemRows>; colorOf: (s: string) => string; readonly: boolean;
  deadEnds: boolean; onDeadEnds: (v: boolean) => void; vent: AutoVentResult | null; onVent: () => void;
  onSelect: (s: string) => void; onSize: (s: string) => void;
}) {
  const { t } = useTranslation();
  const view = useMepView();
  if (rows.length === 0) return <div className="px-2 py-3 text-center text-[10px] text-muted-foreground/70">{t('mep.systems.empty')}</div>;
  const skipped = new Map<string, number>();
  for (const s of vent?.skipped ?? []) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + 1);
  return (
    <div className="flex flex-col gap-px">
      {!readonly && (
        <div className="flex items-center gap-1 px-1">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground" title={t('mep.systems.deadEndsTip')}>
            <input type="checkbox" checked={deadEnds} onChange={e => onDeadEnds(e.target.checked)} data-testid="mep-dead-ends" />
            {t('mep.systems.deadEnds')}
          </label>
          <button type="button" className={btn} onClick={onVent} title={t('mep.vent.tip')} data-testid="mep-auto-vent">{t('mep.vent.run')}</button>
        </div>
      )}
      {vent && (
        <div className="px-1 text-[10px] text-muted-foreground" data-testid="mep-vent-result">
          {t('mep.vent.done', { groups: vent.groups.length, n: vent.groups.reduce((s, g) => s + g.fixtures.length, 0) })}
          {[...skipped].map(([reason, n]) => <span key={reason} className="block text-amber-600">{t(`mep.vent.skip.${reason}`, { n })}</span>)}
        </div>
      )}
      {rows.map(r => (
        <div key={r.system} className="group rounded px-1.5 py-[3px] text-[11px] text-muted-foreground hover:bg-accent"
          onMouseEnter={() => setMepView({ highlight: r.system })} onMouseLeave={() => setMepView({ highlight: null })}>
          <div className="flex items-center gap-1.5">
            <span className="size-3 shrink-0 rounded-sm border border-black/20" style={{ backgroundColor: colorOf(r.system) }} />
            <span className={cn('shrink-0 font-semibold text-foreground', r.system === UNASSIGNED && 'italic text-muted-foreground')}>
              {r.system === UNASSIGNED ? t('mep.systems.unassigned') : r.system}
            </span>
            <span className="min-w-0 flex-1 truncate text-right tabular-nums text-[9px]">
              {t('mep.systems.summary', { curves: r.curves, length: r.length.toFixed(1), devices: r.devices })}
            </span>
          </div>
          <div className="mt-[2px] flex items-center gap-1 pl-[18px]">
            <button type="button" className={btn} onClick={() => onSelect(r.system)} title={t('mep.systems.selectTip')}>{t('mep.systems.select')}</button>
            <button type="button" className={cn(btn, view.isolate === r.system && 'bg-accent text-foreground')}
              onClick={() => setMepView({ isolate: view.isolate === r.system ? null : r.system })} title={t('mep.systems.isolateTip')}>
              {t('mep.systems.isolate')}
            </button>
            {!readonly && r.system !== UNASSIGNED && (
              <button type="button" className={btn} onClick={() => onSize(r.system)} title={t('mep.systems.sizeTip')}>{t('mep.systems.size')}</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckTab({ problems, fills, readonly, onSelect, onCap, onTransition, onDelete }: {
  problems: MepProblem[]; fills: TrayFill[]; readonly: boolean; onSelect: (id: string) => void; onCap: (p: MepProblem) => void;
  onTransition: (p: MepProblem) => void; onDelete: (p: MepProblem) => void;
}) {
  const { t } = useTranslation();
  const view = useMepView();
  const warnings = problems.filter(p => p.severity === 'warning');
  const infos = problems.filter(p => p.severity === 'info');
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center gap-1 px-1 text-[10px] text-muted-foreground">
        <input type="checkbox" checked={view.showProblems} onChange={e => setMepView({ showProblems: e.target.checked, problemMarkers: new Map() })} />
        {t('mep.check.markers')}
      </label>
      {warnings.length === 0 && (
        <div className="px-2 py-2 text-center text-[10px] text-emerald-600" data-testid="mep-check-clean">{t('mep.check.clean')}</div>
      )}
      {[...warnings, ...infos].map((p, i) => (
        <div key={i} className="flex items-start gap-1 rounded px-1.5 py-[2px] text-[10px] hover:bg-accent">
          <span className={cn('mt-[1px] shrink-0 font-bold', p.severity === 'warning' ? 'text-red-500' : 'text-amber-500')}>!</span>
          <button type="button" className="min-w-0 flex-1 cursor-pointer border-none bg-transparent p-0 text-left text-muted-foreground hover:text-foreground"
            onClick={() => onSelect(p.id)} title={problemText(t, p)}>
            <span className="font-semibold">{t(`mep.problem.${p.code}`)}</span> · {p.id}
            <span className="block truncate opacity-70">{problemText(t, p)}</span>
          </button>
          {!readonly && p.code === 'open_end' && (
            <button type="button" className={btn} onClick={() => onCap(p)}>{t('mep.check.cap')}</button>
          )}
          {!readonly && p.code === 'size_mismatch' && (
            <button type="button" className={btn} onClick={() => onTransition(p)} title={t('mep.check.fixTransitionTip')}>{t('mep.check.fixTransition')}</button>
          )}
          {!readonly && p.code === 'duplicate_segment' && (
            <button type="button" className={btn} onClick={() => onDelete(p)} title={t('mep.check.deleteTip')}>{t('mep.check.delete')}</button>
          )}
        </div>
      ))}
      {fills.length > 0 && (
        <div className="mt-1 border-t border-border pt-1" data-testid="mep-tray-fill">
          <div className="flex items-center gap-1 px-1 text-[10px] font-semibold text-foreground">
            <span className="flex-1">{t('mep.check.trayFill')}</span>
            <label className="flex items-center gap-1 font-normal text-muted-foreground" title={t('mep.check.trayLimitTip')}>
              {t('mep.check.trayLimit')}
              <input type="number" min={5} max={100} step={5} value={view.trayFillLimit} data-testid="mep-tray-limit"
                onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setMepView({ trayFillLimit: v }); }}
                className="h-[18px] w-11 rounded border border-border bg-transparent px-1 text-[10px] tabular-nums" />%
            </label>
          </div>
          {fills.map(f => (
            <button key={f.id} type="button" onClick={() => onSelect(f.id)}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-1.5 py-[2px] text-left text-[10px] text-muted-foreground hover:bg-accent">
              <span className="w-12 shrink-0 font-semibold text-foreground">{f.id}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                <span className={cn('block h-full', f.fill > f.limit ? 'bg-red-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, f.fill)}%` }} />
              </span>
              <span className={cn('w-24 shrink-0 text-right tabular-nums', f.fill > f.limit && 'text-red-500')}>
                {t('mep.check.trayFillRow', { fill: f.fill.toFixed(1), limit: f.limit, n: f.cables + f.conduits })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CircuitsTab({ elements, selectedIds, readonly, level, onCreate, onAssign, onPatch, onSchedule }: {
  elements: ReadonlyMap<string, CanonicalElement>; selectedIds: Set<string>; readonly: boolean; level: string;
  onCreate: (c: CanonicalElement) => void; onAssign: (ids: string[], circuitId: string) => void;
  onPatch: (attrsById: Map<string, Record<string, string>>, description: string) => void; onSchedule: () => void;
}) {
  const { t } = useTranslation();
  const view = useMepView();
  const circuits = circuitsIn(elements);
  const selected = [...selectedIds].map(toElementId).map(id => elements.get(id)).filter((e): e is CanonicalElement => !!e);
  const panels = [...elements.values()].filter(isPanel);
  // The selected panel, the panel of a selected circuit, or the only panel on the level.
  const selCircuit = selected.find(e => e.tableName === 'circuit');
  const panel = selected.find(isPanel)
    ?? (selCircuit ? elements.get(selCircuit.hostId || selCircuit.attrs.host_id || '') : undefined)
    ?? (panels.length === 1 ? panels[0] : undefined);
  const devices = selected.filter(e => (e.tableName === 'terminal' || e.tableName === 'equipment') && !isPanel(e));
  const trays = selected.filter(e => e.tableName === 'cable_tray').map(e => e.id);
  const loads = panelLoads(circuits);
  const fmtW = (w: number) => (w >= 10000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 px-1">
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={view.showCircuits} onChange={e => setMepView({ showCircuits: e.target.checked })} />
          {t('mep.circuits.wiring')}
        </label>
        <button type="button" className={cn(btn, 'ml-auto')} disabled={circuits.length === 0} onClick={onSchedule}
          title={t('mep.circuits.scheduleTip')} data-testid="mep-panel-schedule">
          {t('mep.circuits.schedule')}
        </button>
        {!readonly && (
          <button type="button" className={btn} disabled={!panel}
            onClick={() => panel && onCreate(newCircuit(panel.id, elements, level))} title={t('mep.circuits.newTip')}>
            {t('mep.circuits.new')}
          </button>
        )}
      </div>
      {panels.length === 0 && <div className="px-2 py-2 text-center text-[10px] text-muted-foreground/70">{t('mep.circuits.noPanel')}</div>}
      {loads.map(pl => {
        const panelEl = elements.get(pl.panelId);
        const bal = balancePhases(pl.circuits);
        const high = pl.imbalance > 15;
        return (
          <div key={pl.panelId} className="rounded-lg border border-border px-1.5 py-1" data-testid="mep-panel-load">
            <div className="flex items-center gap-1 text-[10px]">
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{panelLabel(panelEl, pl.panelId, drawingLang())}</span>
              <span className={cn('shrink-0 tabular-nums', high ? 'text-red-500' : 'text-muted-foreground')} data-testid="mep-panel-imbalance">
                {t('mep.circuits.imbalance', { pct: pl.imbalance.toFixed(1) })}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[9px] tabular-nums text-muted-foreground">
              {(['L1', 'L2', 'L3'] as const).map(ph => <span key={ph}>{ph} {fmtW(pl.perPhase[ph])}</span>)}
            </div>
            {pl.unassigned > 0 && <div className="text-[9px] text-amber-600">{t('mep.circuits.unassigned', { load: fmtW(pl.unassigned) })}</div>}
            {!readonly && (
              <div className="mt-[2px] flex items-center gap-1 text-[9px] text-muted-foreground">
                {bal.changes.size > 0 ? (
                  <>
                    <span className="min-w-0 flex-1 truncate" title={[...bal.changes].map(([id, ph]) => `${pl.circuits.find(c => c.id === id)?.number ?? id} → ${ph}`).join(', ')}>
                      {t('mep.circuits.balanceHint', { n: bal.changes.size, pct: bal.imbalance.toFixed(1) })}
                    </span>
                    <button type="button" className={btn} data-testid="mep-balance"
                      onClick={() => onPatch(new Map([...bal.changes].map(([id, ph]) => [id, { phase: ph }])), 'Balance phases')}
                      title={t('mep.circuits.balanceTip')}>{t('mep.circuits.balance')}</button>
                  </>
                ) : <span className="flex-1">{t('mep.circuits.balanced')}</span>}
              </div>
            )}
          </div>
        );
      })}
      {circuits.map(c => {
        const panelEl = elements.get(c.panelId);
        const over = c.rating > 0 && c.current > c.rating * 0.8;
        return (
          <div key={c.id} className="flex items-center gap-1.5 rounded px-1.5 py-[2px] text-[10px] text-muted-foreground hover:bg-accent"
            onMouseEnter={() => setMepView({ circuit: c.id })} onMouseLeave={() => setMepView({ circuit: null })}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-foreground" title={panelLabel(panelEl, c.panelId, drawingLang())}>
                {panelLabel(panelEl, c.panelId, drawingLang())} · {c.number}{c.phases.length ? ` · ${c.phases.join('-')}` : ''}
              </span>
              <span className={cn('block truncate tabular-nums', over && 'text-red-500')} data-testid="mep-circuit-summary">
                {t('mep.circuits.summary', { devices: c.devices.length, load: Math.round(c.load) })}
                {c.current > 0 ? ` · ${c.current.toFixed(1)} A` : ''}{c.rating ? ` / ${c.rating} A` : ''}
              </span>
            </span>
            {!readonly && (
              <select className="h-[18px] shrink-0 cursor-pointer rounded border border-border bg-transparent px-0.5 text-[9px] text-muted-foreground"
                value={c.phase} title={t('mep.circuits.phaseTip')} data-testid="mep-circuit-phase"
                onChange={e => onPatch(new Map([[c.id, { phase: e.target.value, ...(e.target.value === 'L1L2L3' ? { poles: '3' } : e.target.value.length === 4 ? { poles: '2' } : e.target.value ? { poles: '1' } : {}) }]]), 'Circuit phase')}>
                <option value="">—</option>
                {PHASE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            {!readonly && trays.length > 0 && (
              <button type="button" className={btn} onClick={() => onPatch(new Map([[c.id, { cable_trays: trays.join(';') }]]), 'Route cable')}
                title={t('mep.circuits.routeTip')}>{t('mep.circuits.route', { n: trays.length })}</button>
            )}
            {!readonly && (
              <button type="button" className={btn} disabled={devices.length === 0}
                onClick={() => onAssign(devices.map(d => d.id), c.id)} title={t('mep.circuits.assignTip')}>
                {t('mep.circuits.assign', { n: devices.length })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SelectedRun({ elements, selectedIds, readonly, onApply }: {
  elements: ReadonlyMap<string, CanonicalElement>; selectedIds: Set<string>; readonly: boolean; onApply: (el: CanonicalElement) => void;
}) {
  const { t } = useTranslation();
  const ids = [...selectedIds].map(toElementId);
  const el = ids.length === 1 ? elements.get(ids[0]) : undefined;
  const flows = useMemo(() => (el && isMepLineTable(el.tableName) ? computeRunFlows(elements) : null), [el, elements]);
  if (!el || !flows || (el.tableName !== 'duct' && el.tableName !== 'pipe')) return null;
  const flow = flows.get(el.id) ?? 0;
  const hyd = runHydraulics(el, flow);
  const raw = el.attrs.shape || (el.tableName === 'duct' ? 'rect' : 'round');
  const shape = raw === 'round' ? 'round' : raw === 'oval' ? 'oval' : 'rect';
  const s = el.tableName === 'duct' ? sizeDuct(flow, shape, parseFloat(el.attrs.size_y || '0') || 0) : sizePipe(flow);
  const mm = (v: number) => Math.round(v * 1000);
  const suggested = s ? (s.shape === 'round' ? `Ø${mm(s.sizeX)}` : `${mm(s.sizeX)}×${mm(s.sizeY)}${s.shape === 'oval' ? ' oval' : ''}`) : '';
  const c = el as MepCurve;
  const len = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y);
  const slope = len > 1e-6 ? (endZ(c, 'end') - endZ(c, 'start')) / len : 0;
  return (
    <div className="mt-2 rounded-lg border border-border px-2 py-1.5 text-[10px] text-muted-foreground" data-testid="mep-run-info">
      <div className="font-semibold text-foreground">{t('mep.run.title', { id: el.id })}</div>
      <div className="tabular-nums">{t('mep.run.flow', { flow: flow.toFixed(flow < 10 ? 2 : 0) })}
        {hyd ? ` · ${t('mep.run.velocity', { v: hyd.velocity.toFixed(2) })} · ${t('mep.run.friction', { r: hyd.friction.toFixed(hyd.friction < 10 ? 2 : 0) })}` : ''}
      </div>
      {el.tableName === 'pipe' && Math.abs(slope) >= 0.0005 && <div className="tabular-nums">{t('mep.run.slope', { s: (Math.abs(slope) * 100).toFixed(2) })}</div>}
      {s && (
        <div className="flex items-center gap-1 tabular-nums">
          <span className="flex-1">{t('mep.run.suggested', { size: suggested, v: s.velocity.toFixed(2) })}</span>
          {!readonly && (
            <button type="button" className={btn} onClick={() => onApply({
              ...c, strokeWidth: s.sizeX,
              attrs: { ...c.attrs, size_x: String(Math.round(s.sizeX * 1000) / 1000), size_y: String(Math.round(s.sizeY * 1000) / 1000) },
            })}>{t('mep.run.apply')}</button>
          )}
        </div>
      )}
    </div>
  );
}

/** A problem's message in the UI language (the check writes English). */
function problemText(t: (k: string, o?: Record<string, unknown>) => string, p: MepProblem): string {
  if (!p.key) return p.message;
  const vars: Record<string, unknown> = { ...p.vars };
  if (typeof vars.table === 'string') vars.table = t(`mep.table.${vars.table}`, { defaultValue: vars.table });
  return t(`mep.msg.${p.key}`, { ...vars, defaultValue: p.message });
}

/** A cap node for the first open end of a run. */
function capOpenEnd(el: CanonicalElement, elements: ReadonlyMap<string, CanonicalElement>, level: string): { node: PointElement; curveId: string; side: 'from' | 'to' } | null {
  if (!isMepLineTable(el.tableName) || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) return null;
  const c = el as MepCurve;
  const side = !(c.attrs.from || '').trim() ? 'from' : !(c.attrs.to || '').trim() ? 'to' : null;
  if (!side) return null;
  const at = side === 'from' ? c.start : c.end;
  const ids = reservedIds(elements);
  const id = generateId('mep_node', ids);
  const node: PointElement = {
    id, tableName: 'mep_node', discipline: 'mep', geometry: 'point', position: { ...at }, width: 0, height: 0,
    attrs: { ...defaultAttrs('mep_node', level), id, fitting: 'cap', kind: '', system_type: c.attrs.system_type ?? '', base_offset: String(endZ(c, side === 'from' ? 'start' : 'end')) },
  };
  return { node, curveId: c.id, side };
}
