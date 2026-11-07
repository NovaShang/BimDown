/**
 * Stair properties panel: the stair calculator (riser / going / 2R+G / width
 * with live warnings), the risers of every run, the multi-storey top level and
 * the automatic railings on either side.
 */
import { useTranslation } from 'react-i18next';
import type { PropertyPanelProps } from './archetypes.ts';
import type { SpatialLineElement } from '../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectContent, SelectItem } from '../components/ui/select';
import { NumberInput } from '../components/NumberInput.tsx';
import {
  assembleStair, comfortableStair, hostRefOf, layoutStair, stairCalc, stairRepetitions, STAIR_LIMITS,
  type RailSide, type StairCheck,
} from '../geometry/stair.ts';
import { STAIR_PART_TABLES, stairRailingElement } from '../model/stairElements.ts';
import { generateId } from '../model/ids.ts';
import { getProjectUnits } from '../utils/units.ts';
import { STAIR_GOING_KEY, clicksRequired, stairSpan } from '../tools/drawStairTool.ts';
import { CommitNumberInput } from '../components/CommitNumberInput.tsx';
import { cn } from '../lib/utils';

const ROW = 'flex items-center gap-2 px-3 py-[3px] text-[11px]';
const LABEL = 'w-[76px] shrink-0 text-[10px] text-muted-foreground';
const VALUE = 'whitespace-nowrap tabular-nums';
const INPUT = 'h-6 w-14 rounded-md border border-input bg-transparent px-1.5 text-right text-[11px] tabular-nums';
const NONE = '__none';

const mm = (m: number) => `${Math.round(m * 1000)} mm`;

function upmOf(unit: string): number {
  switch (unit) {
    case 'mm': return 1000;
    case 'ft': return 1 / 0.3048;
    case 'in': return 1 / 0.0254;
    default: return 1;
  }
}

/** Live warning text of a failed check. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkText(t: (k: string, o?: any) => string, c: StairCheck): string {
  const L = STAIR_LIMITS;
  switch (c.key) {
    case 'riser': return t('stair.calc.riserWarn', { value: mm(c.value), min: mm(L.riserMin), max: mm(L.riserMax) });
    case 'going': return t('stair.calc.goingWarn', { value: mm(c.value), min: mm(L.goingMin) });
    case 'blondel': return t('stair.calc.blondelWarn', { value: mm(c.value), min: mm(L.blondelMin), max: mm(L.blondelMax) });
    case 'width': return t('stair.calc.widthWarn', { value: mm(c.value), min: mm(L.widthMin) });
    case 'landing': return t('stair.calc.landingWarn', { value: mm(c.value) });
  }
}

export default function StairPropertyPanel({ element, editable }: PropertyPanelProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const doc = state.document;
  if (!doc) return null;
  const levels = state.project?.levels ?? [];
  const levelId = doc.levelId;
  const here = levels.find(l => l.id === levelId);
  const children = [...doc.elements.values()].filter(c => hostRefOf(c) === element.id);
  const asm = assembleStair(element, children.filter(c => STAIR_PART_TABLES.has(c.tableName)));
  const elevations = new Map(levels.map(l => [l.id, l.elevation] as const));
  const reps = stairRepetitions(element.attrs, levelId, here?.elevation ?? 0, elevations);
  const calc = stairCalc(asm, upmOf(getProjectUnits(state)), reps.map(r => r.scale));
  const railings = children.filter(c => c.tableName === 'railing');
  const above = [...levels].filter(l => here && l.elevation > here.elevation + 1e-6).sort((a, b) => a.elevation - b.elevation);
  const multistory = element.attrs.multistory_top_level_id ?? '';
  const upm = upmOf(getProjectUnits(state));
  // A single-run stair: risers and going are typed here (the run's end moves with the going)
  const single = asm.runs.length === 1 && asm.ownIsRun && (element.geometry === 'line' || element.geometry === 'spatial_line') ? element as SpatialLineElement : null;
  const reshape = (steps: number, going: number, description: string) => {
    if (!single) return;
    const u = { x: single.end.x - single.start.x, y: single.end.y - single.start.y };
    const l = Math.hypot(u.x, u.y);
    if (l < 1e-9 || !(going > 0) || !(steps >= 1)) return;
    const len = going * steps * upm;
    const end = { x: single.start.x + (u.x / l) * len, y: single.start.y + (u.y / l) * len };
    dispatch({ type: 'APPLY_PATCH', description, patches: new Map([[single.id, { ...single, end, attrs: { ...single.attrs, step_count: String(steps) } }]]) });
  };
  const failing = calc ? calc.checks.some(c => !c.ok && c.key !== 'width' && c.key !== 'landing') : false;

  const toggleRailing = (side: RailSide, on: boolean) => {
    if (on) {
      const id = generateId('railing', new Set(doc.elements.keys()));
      dispatch({ type: 'CREATE_ELEMENTS', elements: [stairRailingElement(id, element.id, side, levelId)], description: 'Add stair railing', selectPrimary: false });
    } else {
      const ids = railings.filter(r => (r.attrs.side || 'left') === side).map(r => r.id);
      if (ids.length > 0) dispatch({ type: 'DELETE_ELEMENTS', ids });
    }
  };

  return (
    <div className="border-b border-border/50 py-1.5" data-testid="stair-panel">
      <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('stair.calc.title')}</div>
      {calc && (
        <>
          <div className={ROW}>
            <span className={LABEL}>{t('stair.calc.risers')}</span>
            {single && editable ? (
              <CommitNumberInput className={INPUT} value={String(calc.risers)} testId="stair-risers"
                onCommit={v => {
                  const n = Math.round(parseFloat(v));
                  // Same run length: the going follows the riser count
                  if (n >= 1 && n !== calc.risers) dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: { step_count: String(n) } });
                }} />
            ) : <span className={VALUE}>{calc.risers}</span>}
            <span className={VALUE}>× {mm(calc.riser)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t('stair.calc.rise')}</span>
            <span className={VALUE}>{mm(calc.rise)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t('stair.calc.going')}</span>
            {single && editable ? (
              <>
                <CommitNumberInput className={INPUT} value={String(Math.round(calc.going * 1000))} testId="stair-going"
                  title={t('stair.calc.goingEditTip')}
                  onCommit={v => reshape(calc.risers, parseFloat(v) / 1000, 'Stair going')} />
                <span className="text-[10px] text-muted-foreground">mm</span>
              </>
            ) : <span className={VALUE}>{mm(calc.going)}</span>}
          </div>
          <div className={ROW}>
            <span className={LABEL}>2R+G</span>
            <span className={VALUE}>{mm(calc.blondel)}</span>
          </div>
          <div className="px-3 pt-0.5" data-testid="stair-checks">
            {calc.checks.map(c => (
              <div key={c.key} className={cn('flex items-start gap-1.5 py-[1px] text-[10px]', c.ok ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400')}
                data-check={c.key} data-ok={c.ok ? 'true' : 'false'}>
                <span className={cn('mt-[4px] size-1.5 shrink-0 rounded-full', c.ok ? 'bg-emerald-500' : 'bg-amber-500')} />
                <span>{c.ok ? t(`stair.calc.ok.${c.key}`) : checkText(t, c)}</span>
              </div>
            ))}
            {failing && single && editable && (
              <button type="button" data-testid="stair-fix"
                className="mt-1 h-[22px] rounded-md border border-amber-500/50 px-2 text-[10px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                title={t('stair.calc.fixTip')}
                onClick={() => {
                  const f = comfortableStair(calc.rise);
                  reshape(f.risers, f.going, 'Fix stair');
                }}>
                {t('stair.calc.fix')}
              </button>
            )}
          </div>
        </>
      )}

      {asm.runs.length > 1 && (
        <div className="pt-1">
          {asm.runs.map((r, i) => (
            <div key={r.id} className={ROW}>
              <span className={LABEL} title={t('stair.risersUnit')}>{t('stair.run', { n: i + 1 })}</span>
              {editable ? (
                <NumberInput className={INPUT} value={String(r.stepCount)} min={1} step={1}
                  onChange={v => {
                    const n = Math.round(parseFloat(v));
                    if (Number.isFinite(n) && n >= 1 && n !== r.stepCount) dispatch({ type: 'UPDATE_ATTRS', id: r.id, attrs: { step_count: String(n) } });
                  }} />
              ) : <span className="tabular-nums">{r.stepCount}</span>}
              <span className="whitespace-nowrap text-[10px] text-muted-foreground tabular-nums">× {mm(r.length / r.stepCount / upmOf(getProjectUnits(state)))}</span>
            </div>
          ))}
        </div>
      )}

      <div className={cn(ROW, 'pt-1')}>
        <span className={LABEL} title={t('stair.multistoryTip')}>{t('stair.repeatTo')}</span>
        <Select value={multistory || NONE} disabled={!editable}
          onValueChange={v => dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: { multistory_top_level_id: v === NONE || !v ? '' : v } })}>
          <SelectTrigger size="sm" className="h-6 min-w-24 flex-1 rounded-md border-input bg-transparent px-1.5 text-[11px]" data-testid="stair-multistory">
            <span className="truncate">{multistory ? (levels.find(l => l.id === multistory)?.name || multistory) : t('stair.multistoryNone')}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('stair.multistoryNone')}</SelectItem>
            {above.map(l => <SelectItem key={l.id} value={l.id}>{l.name || l.number || l.id}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {reps.length > 1 && (
        <div className="px-3 pb-0.5 text-[10px] text-muted-foreground">{t('stair.multistoryCount', { count: reps.length })}</div>
      )}

      <div className={ROW}>
        <span className={LABEL}>{t('stair.railings')}</span>
        {(['left', 'right'] as const).map(side => {
          const on = railings.some(r => (r.attrs.side || 'left') === side);
          return (
            <label key={side} className="flex items-center gap-1 text-[11px]">
              <input type="checkbox" checked={on} disabled={!editable} data-testid={`stair-railing-${side}`}
                onChange={e => toggleRailing(side, e.target.checked)} />
              {t(`stair.side.${side}`)}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Calculator values while placing: riser from the storey and step count, going typed or from the drawn line. */
function drawCalc(state: ReturnType<typeof useEditorState>) {
  const da = state.drawingAttrs;
  const upm = upmOf(getProjectUnits(state));
  const { baseZ, topZ } = stairSpan(state);
  const rise = (topZ - baseZ) / upm;
  const steps = Math.max(1, Math.round(parseFloat(da.step_count ?? '') || 18));
  const riser = rise / steps;
  const typed = parseFloat(da[STAIR_GOING_KEY] ?? '');
  let going: number | null = typed > 0 ? typed / upm : null;
  if (going === null) {
    const pts = state.drawingState?.points ?? [];
    const cur = state.drawingState?.cursor;
    const all = cur ? [...pts, cur] : pts;
    if (all.length === clicksRequired(da.stair_type) && pts.length > 0) {
      const layout = layoutStair(all, parseFloat(da.width ?? '') || 1.2, steps, 0, 1);
      if (layout) going = layout.runs.reduce((acc, r) => acc + Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y), 0) / steps / upm;
    }
  }
  const L = STAIR_LIMITS;
  const riserOk = riser >= L.riserMin - 1e-9 && riser <= L.riserMax + 1e-9;
  const goingOk = going === null || going >= L.goingMin - 1e-9;
  const blondel = going === null ? null : 2 * riser + going;
  const blondelOk = blondel === null || (blondel >= L.blondelMin - 1e-9 && blondel <= L.blondelMax + 1e-9);
  return { upm, rise, steps, riser, going, blondel, riserOk, goingOk, blondelOk };
}

const BAR_INPUT = 'h-[22px] w-[52px] rounded-md border border-input bg-transparent px-1.5 text-right text-[11px]';

/**
 * Drawing-bar stair calculator (Revit's stair type parameters): riser height
 * (sets the riser count), typed going (the last click's run is made to fit),
 * a live riser / going / 2R+G check with a one-click fix, and the multi-storey
 * "repeat up to" level.
 */
export function StairDrawHint() {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const da = state.drawingAttrs;
  const c = drawCalc(state);
  const set = (patch: Record<string, string>) => dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...da, ...patch } });
  const levels = state.project?.levels ?? [];
  const here = levels.find(l => l.id === state.currentLevel);
  const above = levels.filter(l => here && l.elevation > here.elevation + 1e-6).sort((a, b) => a.elevation - b.elevation);
  const multistory = da.multistory_top_level_id ?? '';
  const ok = c.riserOk && c.goingOk && c.blondelOk;
  const L = STAIR_LIMITS;
  const warn = 'text-amber-600 dark:text-amber-400';
  const fix = () => {
    const f = comfortableStair(c.rise);
    set({ step_count: String(f.risers), [STAIR_GOING_KEY]: String(Math.round(f.going * c.upm * 1e4) / 1e4) });
  };
  const fmtLen = (m: number) => String(Math.round(m * c.upm * 1e4) / 1e4);
  return (
    <div className="flex items-center gap-1.5" data-testid="stair-draw-calc">
      <label className="text-[10px] text-muted-foreground" title={t('stair.calc.riserTip')}>{t('stair.calc.riserLabel')}</label>
      <CommitNumberInput className={cn(BAR_INPUT, !c.riserOk && 'border-amber-500')} value={fmtLen(c.riser)} testId="stair-draw-riser"
        title={c.riserOk ? undefined : t('stair.calc.riserWarn', { value: mm(c.riser), min: mm(L.riserMin), max: mm(L.riserMax) })}
        onCommit={v => set({ step_count: String(Math.max(1, Math.round(c.rise / (parseFloat(v) / c.upm)))) })} />
      <label className="text-[10px] text-muted-foreground" title={t('stair.calc.goingTip')}>{t('stair.calc.going')}</label>
      <CommitNumberInput className={cn(BAR_INPUT, !c.goingOk && 'border-amber-500')} value={da[STAIR_GOING_KEY] ?? ''} allowEmpty
        placeholder={c.going !== null && !(parseFloat(da[STAIR_GOING_KEY] ?? '') > 0) ? fmtLen(c.going) : t('stair.calc.auto')}
        testId="stair-draw-going" title={t('stair.calc.goingTip')}
        onCommit={v => set({ [STAIR_GOING_KEY]: v })} />
      <span className={cn('text-[10px] tabular-nums', ok ? 'text-muted-foreground' : warn)} data-testid="stair-draw-hint" data-ok={ok ? 'true' : 'false'}
        title={[
          !c.riserOk && t('stair.calc.riserWarn', { value: mm(c.riser), min: mm(L.riserMin), max: mm(L.riserMax) }),
          !c.goingOk && c.going !== null && t('stair.calc.goingWarn', { value: mm(c.going), min: mm(L.goingMin) }),
          !c.blondelOk && c.blondel !== null && t('stair.calc.blondelWarn', { value: mm(c.blondel), min: mm(L.blondelMin), max: mm(L.blondelMax) }),
        ].filter(Boolean).join('\n') || undefined}>
        {c.steps} × {mm(c.riser)}{c.blondel !== null ? ` · 2R+G ${mm(c.blondel)}` : ''} {ok ? '✓' : '⚠'}
      </span>
      {!ok && (
        <button type="button" className="h-[22px] rounded-md border border-amber-500/50 px-1.5 text-[10px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
          onClick={fix} title={t('stair.calc.fixTip')} data-testid="stair-draw-fix">{t('stair.calc.fix')}</button>
      )}
      <label className="ml-1 text-[10px] text-muted-foreground" title={t('stair.multistoryTip')}>{t('stair.repeatTo')}</label>
      <Select value={multistory || NONE} onValueChange={v => set({ multistory_top_level_id: v === NONE || !v ? '' : v })}>
        <SelectTrigger size="sm" className="h-[22px] min-w-20 rounded-md border-input bg-transparent px-1.5 text-[11px]" data-testid="stair-draw-multistory">
          <span className="truncate">{multistory ? (levels.find(l => l.id === multistory)?.name || multistory) : t('stair.multistoryNone')}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('stair.multistoryNone')}</SelectItem>
          {above.map(l => <SelectItem key={l.id} value={l.id}>{l.name || l.number || l.id}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
