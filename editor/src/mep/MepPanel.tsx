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
import { checkDocument, externalMep, systemRows, systemMemberIds } from './mepModel.ts';
import { setMepView, useMepView, type ProblemMarker } from './mepView.ts';
import { computeRunFlows, runHydraulics, sizeDuct, sizePipe, sizeSystem } from './calc.ts';
import { circuitsIn, isPanel, newCircuit } from './circuits.ts';
import type { MepProblem } from './mepCheck.ts';
import { cn } from '../lib/utils.ts';
import { reservedIds } from './reservedIds.ts';
import { transitionAtPort } from './transitions.ts';
import { panelLabel } from '../schedule/mepSchedules.ts';
import { drawingLang } from '../export/drawing/labels.ts';
import ClashTab from './ClashTab.tsx';

type Tab = 'systems' | 'check' | 'circuits' | 'clash';
type MepCurve = LineElement | SpatialLineElement;

const btn = 'cursor-pointer rounded border border-border bg-transparent px-1.5 py-[1px] text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40';

export default function MepPanel() {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const { selectedIds } = useSelectionState();
  const dispatch = useEditorDispatch();
  const view = useMepView();
  const [tab, setTab] = useState<Tab>('systems');
  const [deadEnds, setDeadEnds] = useState(true);
  const elements = state.document?.elements;
  const level = state.currentLevel;
  const readonly = state.readonly;
  const sel = (ids: string[]) => dispatch({ type: 'SELECT', ids: ids.map(id => level ? toSelectionId(level, id) : id) });

  const rows = useMemo(() => (elements ? systemRows(elements) : []), [elements]);
  const project = state.project;
  const ext = useMemo(() => externalMep(project, level), [project, level]);
  const problems = useMemo(() => (elements && (tab === 'check' || view.showProblems) ? checkDocument(elements, ext) : []), [elements, ext, tab, view.showProblems]);
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
  const colorOf = (code: string) => resolveMepSystemColor(code, systems.find(s => s.system_type === code)?.color);

  return (
    <div className="glass-panel flex shrink-0 max-h-[40%] flex-col rounded-2xl border border-[var(--panel-border)] shadow-[var(--shadow-panel)]" data-testid="mep-panel">
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
          <SystemsTab rows={rows} colorOf={colorOf} readonly={readonly} deadEnds={deadEnds} onDeadEnds={setDeadEnds}
            onSelect={sys => sel(systemMemberIds(elements, sys))}
            onSize={sys => {
              const resized = sizeSystem(elements, sys, { deadEnds, levelId: level });
              if (resized.length) dispatch({ type: 'APPLY_PATCH', patches: new Map(resized.map(e => [e.id, e])), description: `Size ${sys}` });
            }} />
        )}
        {tab === 'check' && (
          <CheckTab problems={problems} readonly={readonly} onSelect={id => sel([id])}
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
            onAssign={(ids, circuitId) => dispatch({ type: 'UPDATE_ATTRS_MANY', ids, attrs: { circuit_id: circuitId } })} />
        )}
        {tab === 'clash' && <ClashTab />}
        <SelectedRun elements={elements} selectedIds={selectedIds} readonly={readonly}
          onApply={el => dispatch({ type: 'APPLY_PATCH', patches: new Map([[el.id, el]]), description: 'Apply suggested size' })} />
      </div>
    </div>
  );
}

function SystemsTab({ rows, colorOf, readonly, deadEnds, onDeadEnds, onSelect, onSize }: {
  rows: ReturnType<typeof systemRows>; colorOf: (s: string) => string; readonly: boolean;
  deadEnds: boolean; onDeadEnds: (v: boolean) => void;
  onSelect: (s: string) => void; onSize: (s: string) => void;
}) {
  const { t } = useTranslation();
  const view = useMepView();
  if (rows.length === 0) return <div className="px-2 py-3 text-center text-[10px] text-muted-foreground/70">{t('mep.systems.empty')}</div>;
  return (
    <div className="flex flex-col gap-px">
      {!readonly && (
        <label className="flex cursor-pointer items-center gap-1 px-1 text-[10px] text-muted-foreground" title={t('mep.systems.deadEndsTip')}>
          <input type="checkbox" checked={deadEnds} onChange={e => onDeadEnds(e.target.checked)} data-testid="mep-dead-ends" />
          {t('mep.systems.deadEnds')}
        </label>
      )}
      {rows.map(r => (
        <div key={r.system} className="group rounded px-1.5 py-[3px] text-[11px] text-muted-foreground hover:bg-accent"
          onMouseEnter={() => setMepView({ highlight: r.system })} onMouseLeave={() => setMepView({ highlight: null })}>
          <div className="flex items-center gap-1.5">
            <span className="size-3 shrink-0 rounded-sm border border-black/20" style={{ backgroundColor: colorOf(r.system) }} />
            <span className="shrink-0 font-semibold text-foreground">{r.system}</span>
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
            {!readonly && (
              <button type="button" className={btn} onClick={() => onSize(r.system)} title={t('mep.systems.sizeTip')}>{t('mep.systems.size')}</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckTab({ problems, readonly, onSelect, onCap, onTransition, onDelete }: {
  problems: MepProblem[]; readonly: boolean; onSelect: (id: string) => void; onCap: (p: MepProblem) => void;
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
          <button type="button" className="flex-1 cursor-pointer border-none bg-transparent p-0 text-left text-muted-foreground hover:text-foreground"
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
    </div>
  );
}

function CircuitsTab({ elements, selectedIds, readonly, level, onCreate, onAssign }: {
  elements: ReadonlyMap<string, CanonicalElement>; selectedIds: Set<string>; readonly: boolean; level: string;
  onCreate: (c: CanonicalElement) => void; onAssign: (ids: string[], circuitId: string) => void;
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
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 px-1">
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={view.showCircuits} onChange={e => setMepView({ showCircuits: e.target.checked })} />
          {t('mep.circuits.wiring')}
        </label>
        {!readonly && (
          <button type="button" className={cn(btn, 'ml-auto')} disabled={!panel}
            onClick={() => panel && onCreate(newCircuit(panel.id, elements, level))} title={t('mep.circuits.newTip')}>
            {t('mep.circuits.new')}
          </button>
        )}
      </div>
      {panels.length === 0 && <div className="px-2 py-2 text-center text-[10px] text-muted-foreground/70">{t('mep.circuits.noPanel')}</div>}
      {circuits.map(c => {
        const panelEl = elements.get(c.panelId);
        const over = c.voltage > 0 && c.rating > 0 && c.load > c.voltage * c.rating * 0.8;
        return (
          <div key={c.id} className="flex items-center gap-1.5 rounded px-1.5 py-[2px] text-[10px] text-muted-foreground hover:bg-accent"
            onMouseEnter={() => setMepView({ circuit: c.id })} onMouseLeave={() => setMepView({ circuit: null })}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-foreground" title={panelLabel(panelEl, c.panelId, drawingLang())}>{panelLabel(panelEl, c.panelId, drawingLang())} · {c.number}</span>
              <span className={cn('block truncate tabular-nums', over && 'text-red-500')}>
                {t('mep.circuits.summary', { devices: c.devices.length, load: Math.round(c.load) })}{c.rating ? ` / ${c.rating} A` : ''}
              </span>
            </span>
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
  const shape = (el.attrs.shape || (el.tableName === 'duct' ? 'rect' : 'round')) === 'round' ? 'round' : 'rect';
  const s = el.tableName === 'duct' ? sizeDuct(flow, shape, parseFloat(el.attrs.size_y || '0') || 0) : sizePipe(flow);
  const mm = (v: number) => Math.round(v * 1000);
  const suggested = s ? (s.shape === 'round' ? `Ø${mm(s.sizeX)}` : `${mm(s.sizeX)}×${mm(s.sizeY)}`) : '';
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
