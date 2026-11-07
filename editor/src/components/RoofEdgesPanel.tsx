/**
 * Roof edges (Revit footprint sketch "Defines slope"): per footprint edge,
 * whether it slopes and at what angle, plus one-click shape presets. Edge
 * numbers match the labels drawn on the selected roof in plan.
 */
import { useTranslation } from 'react-i18next';
import type { PropertyPanelProps } from '../elements/archetypes.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { formatNumberList, legacyEdgeSlopes, pointInPolygon, roofInputFor } from '../geometry/roofSolver.ts';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { NumberInput } from './NumberInput.tsx';
import { cn } from '../lib/utils';

const INPUT = 'h-[20px] w-[46px] rounded-md border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]';
const PRESETS = ['hip', 'gable', 'shed', 'flat'] as const;

export default function RoofEdgesPanel({ element, editable }: PropertyPanelProps) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const doc = useEditorState().document;
  if (element.geometry !== 'polygon' || element.vertices.length < 3) return null;
  const attach = editable && doc ? <AttachWalls roof={element} elements={doc.elements} /> : null;
  if (element.attrs.roof_type === 'extrusion') {
    return (
      <Section title={t('roof.edges')}>
        <p className="text-[10px] leading-snug text-muted-foreground">{t('roof.extrusionHint')}</p>
        {attach}
      </Section>
    );
  }
  const vs = element.vertices;
  const input = roofInputFor(vs, element.attrs);
  const slopes = input.edgeSlopes.length === vs.length ? input.edgeSlopes : vs.map(() => 0);
  const typical = Math.max(...slopes, parseFloat(element.attrs.slope || '0') || 0) || 30;

  const write = (next: number[], roofType?: string) => {
    const max = Math.max(0, ...next);
    const attrs: Record<string, string> = {
      edge_slopes: next.some(v => v > 0) ? formatNumberList(next) : '',
      slope: String(Math.round(max * 100) / 100),
    };
    // The shape name follows the edges (a mansard keeps its name while every edge slopes).
    const n = next.filter(v => v > 0).length;
    const cur = element.attrs.roof_type;
    if (roofType) attrs.roof_type = roofType;
    else if (n === 0) attrs.roof_type = 'flat';
    else if (cur === 'flat' && max < 5) attrs.roof_type = 'flat'; // drainage falls
    else if (n === next.length) attrs.roof_type = cur === 'mansard' ? 'mansard' : 'hip';
    else attrs.roof_type = n === 1 ? 'shed' : 'gable';
    dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs });
  };
  const preset = (kind: typeof PRESETS[number]) => {
    if (kind === 'flat') { write(vs.map(() => 0), 'flat'); return; }
    write(legacyEdgeSlopes(vs, kind, typical), kind);
  };

  return (
    <Section title={t('roof.edges')}>
      {editable && (
        <div className="mb-1 flex flex-wrap gap-1" data-testid="roof-presets">
          {PRESETS.map(k => (
            <button key={k} type="button" onClick={() => preset(k)}
              className="cursor-pointer rounded border border-border/60 bg-transparent px-1.5 py-0.5 text-[10px] text-foreground/80 hover:bg-foreground/[0.06]">
              {t(`option.${k[0].toUpperCase()}${k.slice(1)}`, k)}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col" data-testid="roof-edges">
        {vs.map((a, i) => {
          const b = vs[(i + 1) % vs.length];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          const on = slopes[i] > 0;
          return (
            <div key={i} className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-[2px] hover:bg-foreground/[0.03]" data-testid={`roof-edge-${i + 1}`}>
              <span className={cn('w-4 shrink-0 text-right text-[10px] font-semibold tabular-nums', on ? 'text-[#3a7bff]' : 'text-muted-foreground/70')}>{i + 1}</span>
              <span className="w-[42px] shrink-0 text-[10px] tabular-nums text-muted-foreground">{len.toFixed(2)}</span>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-[10px] text-foreground/80">
                <input type="checkbox" checked={on} disabled={!editable} className="size-3 accent-[var(--color-accent)]"
                  onChange={e => {
                    const next = [...slopes];
                    next[i] = e.target.checked ? typical : 0;
                    write(next);
                  }} />
                <span className="truncate" title={t('roof.definesSlope')}>{t('roof.slopeShort')}</span>
              </label>
              {on && editable ? (
                <NumberInput className={INPUT} value={String(slopes[i])} step={0.5} min={0.1} max={80}
                  onChange={v => {
                    const n = parseFloat(v);
                    if (!Number.isFinite(n)) return;
                    const next = [...slopes];
                    next[i] = Math.max(0, n);
                    write(next);
                  }} />
              ) : (
                <span className="w-[46px] text-right text-[11px] tabular-nums text-foreground/70">{on ? slopes[i] : '—'}</span>
              )}
              <span className="w-2 text-[9px] text-muted-foreground/60">{on ? '°' : ''}</span>
            </div>
          );
        })}
      </div>
      {attach}
    </Section>
  );
}

const WALL_TABLES = new Set(['wall', 'structure_wall']);

/** Attach / detach the tops of this level's walls standing under the roof. */
function AttachWalls({ roof, elements }: { roof: CanonicalElement; elements: ReadonlyMap<string, CanonicalElement> }) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  if (roof.geometry !== 'polygon') return null;
  const under: string[] = [], attached: string[] = [];
  for (const el of elements.values()) {
    if (!WALL_TABLES.has(el.tableName) || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    const ln = el as LineElement;
    const mid = { x: (ln.start.x + ln.end.x) / 2, y: (ln.start.y + ln.end.y) / 2 };
    if (el.attrs.top_attach_id === roof.id) attached.push(el.id);
    else if (pointInPolygon(mid, roof.vertices)) under.push(el.id);
  }
  if (under.length === 0 && attached.length === 0) return null;
  const btn = 'cursor-pointer rounded border border-border/60 bg-transparent px-1.5 py-0.5 text-[10px] text-foreground/80 hover:bg-foreground/[0.06]';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="roof-attach">
      {under.length > 0 && (
        <button type="button" className={btn} data-testid="roof-attach-walls"
          onClick={() => dispatch({ type: 'UPDATE_ATTRS_MANY', ids: under, attrs: { top_attach_id: roof.id } })}>
          {t('roof.attachWalls', { count: under.length })}
        </button>
      )}
      {attached.length > 0 && (
        <button type="button" className={btn} data-testid="roof-detach-walls"
          onClick={() => dispatch({ type: 'UPDATE_ATTRS_MANY', ids: attached, attrs: { top_attach_id: '' } })}>
          {t('roof.detachWalls', { count: attached.length })}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1" data-testid="roof-edges-panel">
      <div className="bg-foreground/[0.05] px-3 py-1.5 text-[10px] font-semibold text-foreground/65">{title}</div>
      <div className="px-3 pb-1.5 pt-1">{children}</div>
    </div>
  );
}
