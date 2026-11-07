/**
 * Stair properties panel: the stair calculator (riser / going / 2R+G / width
 * with live warnings), the risers of every run, the multi-storey top level and
 * the automatic railings on either side.
 */
import { useTranslation } from 'react-i18next';
import type { PropertyPanelProps } from './archetypes.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectContent, SelectItem } from '../components/ui/select';
import { NumberInput } from '../components/NumberInput.tsx';
import {
  assembleStair, hostRefOf, stairCalc, stairRepetitions, STAIR_LIMITS,
  type RailSide, type StairCheck,
} from '../geometry/stair.ts';
import { STAIR_PART_TABLES, stairRailingElement } from '../model/stairElements.ts';
import { generateId } from '../model/ids.ts';
import { getProjectUnits } from '../utils/units.ts';
import { stairSpan } from '../tools/drawStairTool.ts';
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
            <span className={VALUE}>{calc.risers} × {mm(calc.riser)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t('stair.calc.rise')}</span>
            <span className={VALUE}>{mm(calc.rise)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>{t('stair.calc.going')}</span>
            <span className={VALUE}>{mm(calc.going)}</span>
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
        <span className={LABEL}>{t('stair.multistoryTop')}</span>
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

/** Drawing-bar hint while placing a stair: the riser the storey and step count give, with a warning. */
export function StairDrawHint() {
  const { t } = useTranslation();
  const state = useEditorState();
  const { baseZ, topZ } = stairSpan(state);
  const steps = Math.max(1, Math.round(parseFloat(state.drawingAttrs.step_count ?? '') || 18));
  const riser = (topZ - baseZ) / steps / upmOf(getProjectUnits(state));
  const ok = riser >= STAIR_LIMITS.riserMin - 1e-9 && riser <= STAIR_LIMITS.riserMax + 1e-9;
  return (
    <span className={cn('text-[10px] tabular-nums', ok ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400')}
      data-testid="stair-draw-hint" title={ok ? undefined : t('stair.calc.riserWarn', { value: mm(riser), min: mm(STAIR_LIMITS.riserMin), max: mm(STAIR_LIMITS.riserMax) })}>
      {t('stair.calc.riserShort', { value: mm(riser) })}{ok ? '' : ' ⚠'}
    </span>
  );
}
