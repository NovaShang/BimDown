import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import {
  LAYER_FUNCTIONS, duplicateType, findType, layerTotal, nextLayerIds,
  removeType, typeTableDef, typeTableFor, upsertType,
  type ElementType, type TypeCatalog, type TypeLayer,
} from '../model/types/catalog.ts';
import { starterCatalog } from '../model/types/starter.ts';
import {
  MATERIAL_OPTIONS, OPERATION_OPTIONS, WINDOW_OPERATION_OPTIONS, STRUCTURAL_SHAPE_OPTIONS, SHAPE_OPTIONS,
} from '../elements/_options.ts';
import { LayerHatchDefs, layerFill } from '../elements/_layerHatch.tsx';
import { getProjectUnits, getUnitSuffix } from '../utils/units.ts';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { NumberInput } from './NumberInput.tsx';
import { countTypeUsage } from '../state/typeEdits.ts';
import { cn } from '../lib/utils';

type Option = { value: string; label: string };

interface ParamMeta {
  /** i18n key. */
  label: string;
  kind: 'length' | 'number' | 'select' | 'text';
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  options?: Option[];
}

const THERMAL = new Set(['u_value', 'shgc', 'vt']);

function paramMeta(typeTable: string, key: string): ParamMeta {
  switch (key) {
    case 'material': return { label: 'field.Material', kind: 'select', options: MATERIAL_OPTIONS };
    case 'operation': return {
      label: 'field.Operation', kind: 'select',
      options: typeTable === 'window_type' ? WINDOW_OPERATION_OPTIONS : OPERATION_OPTIONS,
    };
    case 'shape': return { label: 'field.Shape', kind: 'select', options: typeTable === 'column_type' || typeTable === 'beam_type' ? STRUCTURAL_SHAPE_OPTIONS : SHAPE_OPTIONS };
    case 'thickness': return { label: 'field.Thickness', kind: 'length', step: 0.001, min: 0 };
    case 'width': return { label: 'field.Width', kind: 'length', step: 0.01, min: 0.1 };
    case 'height': return { label: 'field.Height', kind: 'length', step: 0.01, min: 0.1 };
    case 'frame_width': return { label: 'type.frameWidth', kind: 'length', step: 0.005, min: 0 };
    case 'u_value': return { label: 'type.uValue', kind: 'number', unit: 'W/(m²·K)', step: 0.05, min: 0 };
    case 'shgc': return { label: 'type.shgc', kind: 'number', step: 0.01, min: 0, max: 1 };
    case 'vt': return { label: 'type.vt', kind: 'number', step: 0.01, min: 0, max: 1 };
    case 'u_spacing': return { label: 'field.U Spacing', kind: 'length', step: 0.1, min: 0.1 };
    case 'v_spacing': return { label: 'field.V Spacing', kind: 'length', step: 0.1, min: 0.1 };
    case 'panel_material': return { label: 'field.Panel Material', kind: 'text' };
    case 'size_x': return { label: 'field.Width', kind: 'length', step: 0.01, min: 0.01 };
    case 'size_y': return { label: 'field.Depth', kind: 'length', step: 0.01, min: 0.01 };
    case 'flange': return { label: 'field.Flange Thk', kind: 'length', step: 0.001, min: 0 };
    case 'web': return { label: 'field.Web Thk', kind: 'length', step: 0.001, min: 0 };
    default: return { label: key, kind: 'text' };
  }
}

const LABEL = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground';
const CELL_INPUT = 'h-7 w-full rounded-md border border-input bg-transparent px-1.5 text-[11px] tabular-nums';
const BTN = 'inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';
const ICON_BTN = 'inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent';

interface EditTypeDialogProps {
  open: boolean;
  /** Instance table the dialog was opened from (picks the category). */
  instanceTable: string;
  /** Type selected when the dialog opens ('' = first of the category). */
  typeId: string;
  onClose: () => void;
  /** After OK, with the type selected in the dialog (e.g. a fresh duplicate) and the applied catalog. */
  onApplied?: (typeId: string, types: TypeCatalog) => void;
}

/**
 * Revit-style "Type Properties": pick a type of the category, duplicate,
 * rename or delete it, edit its layers (walls, floors, roofs, ceilings) or its
 * parameters (doors, windows, curtain walls, sections). OK applies everything
 * as one undoable edit; every element following the type updates.
 */
export default function EditTypeDialog({ open, instanceTable, typeId, onClose, onApplied }: EditTypeDialogProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const def = typeTableFor(instanceTable);
  const unit = getUnitSuffix(getProjectUnits(state)).trim();

  const [draft, setDraft] = useState<TypeCatalog>(() => state.project?.types ?? starterCatalog());
  const [selId, setSelId] = useState(typeId);
  // Layer numbers as typed ("0.", "0.1"…), keyed `${layerId}:${field}`; the
  // layer keeps the parsed number.
  const [raw, setRaw] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const base = state.project?.types ?? starterCatalog();
    setDraft(base);
    setRaw({});
    const first = base.types.find(x => x.table === def?.table)?.id ?? '';
    setSelId(findType(base, typeId)?.table === def?.table ? typeId : first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typeId, instanceTable]);

  const sel = findType(draft, selId);
  const categoryTypes = useMemo(() => draft.types.filter(x => x.table === def?.table), [draft, def]);
  const usage = sel ? countTypeUsage(state, sel.id) : 0;

  if (!open || !def) return null;

  const layered = typeTableDef(def.table)?.layered ?? false;
  const isWall = def.table === 'wall_type';
  const update = (next: ElementType) => setDraft(d => upsertType(d, next));

  const error = (() => {
    if (!sel) return null;
    if (!sel.name.trim()) return t('type.error.name');
    if (layered && sel.layers.length === 0) return t('type.error.layers');
    if (layered && sel.layers.some(l => !(l.thickness > 0))) return t('type.error.thickness');
    if ((def.table === 'door_type' || def.table === 'window_type') && !(Number(sel.values.width) > 0)) return t('type.error.width');
    return null;
  })();

  const apply = () => {
    if (error) return;
    const original = state.project?.types;
    const changed = JSON.stringify(original?.types) !== JSON.stringify(draft.types);
    const applied: TypeCatalog = changed || !original?.saved ? { types: draft.types, saved: true } : original;
    if (applied !== original) dispatch({ type: 'UPDATE_TYPES', types: applied, description: 'Edit type' });
    onApplied?.(selId, applied);
    onClose();
  };

  const setValue = (key: string, value: string) => sel && update({ ...sel, values: { ...sel.values, [key]: value } });
  const setLayer = (i: number, patch: Partial<TypeLayer>) =>
    sel && update({ ...sel, layers: sel.layers.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const moveLayer = (i: number, dir: -1 | 1) => {
    if (!sel) return;
    const layers = [...sel.layers];
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    update({ ...sel, layers });
  };
  const setLayerNumber = (i: number, l: TypeLayer, field: 'thickness' | 'conductivity', v: string) => {
    setRaw(r => ({ ...r, [`${l.id}:${field}`]: v }));
    const n = Number(v);
    if (field === 'conductivity' && v.trim() === '') setLayer(i, { conductivity: undefined });
    else if (v.trim() !== '' && Number.isFinite(n)) setLayer(i, { [field]: n });
  };
  const layerNumber = (l: TypeLayer, field: 'thickness' | 'conductivity') =>
    raw[`${l.id}:${field}`] ?? (l[field] !== undefined ? String(l[field]) : '');

  const addLayer = () => {
    if (!sel) return;
    const [id] = nextLayerIds(draft, 1);
    update({ ...sel, layers: [...sel.layers, { id, seq: sel.layers.length + 1, function: 'finish', material: 'gypsum', thickness: 0.0125, name: '' }] });
  };

  const paramKeys = def.columns.filter(k => !(layered && k === 'thickness'));
  const mainKeys = paramKeys.filter(k => !THERMAL.has(k));
  const thermalKeys = paramKeys.filter(k => THERMAL.has(k));
  const total = sel ? layerTotal(sel) : undefined;

  const renderParam = (key: string) => {
    if (!sel) return null;
    const m = paramMeta(def.table, key);
    const value = sel.values[key] ?? '';
    const shownUnit = m.kind === 'length' ? unit : m.unit;
    return (
      <div key={key} className="min-w-0">
        <label className={LABEL}>{t(m.label, m.label)}{shownUnit ? ` (${shownUnit})` : ''}</label>
        {m.kind === 'select' ? (
          <Select value={value} onValueChange={v => { if (v) setValue(key, v); }}>
            <SelectTrigger size="sm" className={cn(CELL_INPUT, 'justify-between')} data-testid={`type-param-${key}`}>
              <span className="truncate">{(() => {
                const o = m.options?.find(o => o.value === value);
                return o ? t(`option.${o.label}`, o.label) : value || '—';
              })()}</span>
            </SelectTrigger>
            <SelectContent>
              {m.options?.map(o => <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`, o.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : m.kind === 'text' ? (
          <Input className={CELL_INPUT} value={value} onChange={e => setValue(key, e.target.value)} />
        ) : (
          <NumberInput className={cn(CELL_INPUT, 'text-right')} value={value} onChange={v => setValue(key, v)}
            step={m.step} min={m.min} max={m.max} />
        )}
      </div>
    );
  };

  // Portal: the panels that open the dialog are transformed (animations), which
  // would trap a `fixed` overlay inside them.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[680px] max-w-[95vw] flex-col rounded-xl border border-border bg-card shadow-xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
        role="dialog"
        aria-label={t('type.properties')}
        data-testid="edit-type-dialog"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="text-[13px] font-semibold">{t('type.properties')}</div>
          <span className="rounded bg-[var(--bg-input)] px-1.5 py-0.5 text-[10px] text-muted-foreground">{t(`type.category.${def.table}`)}</span>
          <button type="button" className={cn(ICON_BTN, 'ml-auto')} onClick={onClose} aria-label={t('dialog.cancel')}><X className="size-4" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* Type row */}
          <label className={LABEL}>{t('type.label')}</label>
          <div className="mb-3 flex items-center gap-2">
            <Select value={selId} onValueChange={v => { if (v) setSelId(v); }}>
              <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 rounded-md border border-input px-2 text-[12px]" data-testid="type-dialog-select">
                <span className="truncate">{sel?.name ?? '—'}</span>
              </SelectTrigger>
              <SelectContent>
                {categoryTypes.map(x => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <button type="button" className={BTN} disabled={!sel} data-testid="type-duplicate"
              onClick={() => { if (!sel) return; const copy = duplicateType(draft, sel); setDraft(d => upsertType(d, copy)); setSelId(copy.id); }}>
              <Copy className="size-3.5" />{t('type.duplicate')}
            </button>
            <button type="button" className={BTN} disabled={!sel || usage > 0 || categoryTypes.length <= 1}
              title={usage > 0 ? t('type.inUse') : undefined}
              onClick={() => {
                if (!sel) return;
                const next = removeType(draft, sel.id);
                setDraft(next);
                setSelId(next.types.find(x => x.table === def.table)?.id ?? '');
              }}>
              <Trash2 className="size-3.5" />{t('type.delete')}
            </button>
          </div>

          {sel && (
            <>
              <div className="mb-3 grid grid-cols-[1fr_1.4fr] gap-2">
                <div>
                  <label className={LABEL}>{t('type.name')}</label>
                  <Input className={CELL_INPUT} value={sel.name} data-testid="type-name"
                    onChange={e => update({ ...sel, name: e.target.value })} />
                </div>
                <div>
                  <label className={LABEL}>{t('type.description')}</label>
                  <Input className={CELL_INPUT} value={sel.description} onChange={e => update({ ...sel, description: e.target.value })} />
                </div>
              </div>

              {layered && (
                <section className="mb-3">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <div className="text-[11px] font-semibold">{t('type.structure')}</div>
                    <div className="text-[11px] tabular-nums text-muted-foreground" data-testid="type-total">
                      {t('type.total')}: <span className="font-semibold text-foreground">{total !== undefined ? `${+total.toFixed(4)} ${unit}` : '—'}</span>
                    </div>
                  </div>
                  <LayerPreview layers={sel.layers} outerLabel={t(isWall ? 'type.exterior' : 'type.top')} innerLabel={t(isWall ? 'type.interior' : 'type.bottom')} />
                  <table className="mt-2 w-full border-collapse text-[11px]" data-testid="type-layers">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="w-9 pb-1 font-medium">#</th>
                        <th className="pb-1 pr-1 font-medium">{t('type.layer.function')}</th>
                        <th className="pb-1 pr-1 font-medium">{t('field.Material')}</th>
                        <th className="w-[84px] pb-1 pr-1 font-medium">{t('field.Thickness')} ({unit})</th>
                        <th className="w-[72px] pb-1 pr-1 font-medium normal-case" title="W/(m·K)">λ W/(m·K)</th>
                        <th className="pb-1 pr-1 font-medium">{t('type.name')}</th>
                        <th className="w-[72px]" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td colSpan={7} className="pb-0.5 text-[10px] italic text-muted-foreground">{t(isWall ? 'type.exterior' : 'type.top')}</td></tr>
                      {sel.layers.map((l, i) => (
                        <tr key={l.id} className="align-middle">
                          <td className="whitespace-nowrap pr-1 text-muted-foreground tabular-nums">
                            <span className="mr-1 inline-block size-2.5 rounded-sm align-middle" style={{ background: layerFill(l).split(' ').pop() }} />
                            {i + 1}
                          </td>
                          <td className="py-0.5 pr-1">
                            <Select value={l.function} onValueChange={v => { if (v) setLayer(i, { function: v, ...(v === 'air_gap' ? { material: '' } : {}) }); }}>
                              <SelectTrigger size="sm" className={CELL_INPUT}><span className="truncate">{t(`type.fn.${l.function}`, l.function)}</span></SelectTrigger>
                              <SelectContent>{LAYER_FUNCTIONS.map(f => <SelectItem key={f} value={f}>{t(`type.fn.${f}`)}</SelectItem>)}</SelectContent>
                            </Select>
                          </td>
                          <td className="py-0.5 pr-1">
                            <Select value={l.material || '__none__'} onValueChange={v => { if (v) setLayer(i, { material: v === '__none__' ? '' : v }); }}>
                              <SelectTrigger size="sm" className={CELL_INPUT}><span className="truncate">{(() => {
                                const o = MATERIAL_OPTIONS?.find(o => o.value === l.material);
                                return o ? t(`option.${o.label}`, o.label) : '—';
                              })()}</span></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">—</SelectItem>
                                {MATERIAL_OPTIONS?.map(o => <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`, o.label)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumberInput className={cn(CELL_INPUT, 'text-right')} value={layerNumber(l, 'thickness')} step={0.0005} min={0}
                              onChange={v => setLayerNumber(i, l, 'thickness', v)} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumberInput className={cn(CELL_INPUT, 'text-right')} value={layerNumber(l, 'conductivity')} step={0.001} min={0}
                              onChange={v => setLayerNumber(i, l, 'conductivity', v)} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <Input className={CELL_INPUT} value={l.name} onChange={e => setLayer(i, { name: e.target.value })} />
                          </td>
                          <td className="whitespace-nowrap py-0.5 text-right">
                            <button type="button" className={ICON_BTN} disabled={i === 0} onClick={() => moveLayer(i, -1)} title={t('type.layer.up')}><ArrowUp className="size-3.5" /></button>
                            <button type="button" className={ICON_BTN} disabled={i === sel.layers.length - 1} onClick={() => moveLayer(i, 1)} title={t('type.layer.down')}><ArrowDown className="size-3.5" /></button>
                            <button type="button" className={ICON_BTN} onClick={() => update({ ...sel, layers: sel.layers.filter((_, j) => j !== i) })} title={t('type.layer.remove')}><Trash2 className="size-3.5" /></button>
                          </td>
                        </tr>
                      ))}
                      <tr><td colSpan={7} className="pt-0.5 text-[10px] italic text-muted-foreground">{t(isWall ? 'type.interior' : 'type.bottom')}</td></tr>
                    </tbody>
                  </table>
                  <button type="button" className={cn(BTN, 'mt-1.5')} onClick={addLayer} data-testid="type-add-layer"><Plus className="size-3.5" />{t('type.layer.add')}</button>
                </section>
              )}

              {mainKeys.length > 0 && (
                <section className="mb-3">
                  <div className="mb-1.5 text-[11px] font-semibold">{t('type.parameters')}</div>
                  <div className="grid grid-cols-3 gap-2">{mainKeys.map(renderParam)}</div>
                </section>
              )}
              {thermalKeys.length > 0 && (
                <section className="mb-1">
                  <div className="mb-1.5 text-[11px] font-semibold">{t('type.thermal')}</div>
                  <div className="grid grid-cols-3 gap-2">{thermalKeys.map(renderParam)}</div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground" data-testid="type-usage">{t('type.usage', { count: usage })}</span>
          {error && <span className="text-[11px] text-destructive">{error}</span>}
          <div className="ml-auto flex gap-2">
            <button type="button" className={cn(BTN, 'px-3 py-1.5')} onClick={onClose}>{t('dialog.cancel')}</button>
            <button type="button" disabled={!!error || !sel} onClick={apply} data-testid="type-ok"
              className="rounded-md border-none bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
              {t('type.ok')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Section through the build-up, exterior/top on the left, at true proportions. */
function LayerPreview({ layers, outerLabel, innerLabel }: { layers: TypeLayer[]; outerLabel: string; innerLabel: string }) {
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  if (!(total > 0)) return null;
  const h = Math.max(total * 0.35, 0.08);
  const xs = layers.map((_, i) => layers.slice(0, i).reduce((acc, l) => acc + l.thickness, 0));
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">{outerLabel}</span>
      <svg viewBox={`0 0 ${total} ${h}`} preserveAspectRatio="none" className="h-10 min-w-0 flex-1 rounded border border-border" data-testid="type-preview">
        <LayerHatchDefs />
        {layers.map((l, i) => (
          <rect key={l.id} x={xs[i]} y={0} width={l.thickness} height={h} fill={layerFill(l)} stroke="#4b5563" strokeWidth={total / 400} />
        ))}
      </svg>
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{innerLabel}</span>
    </div>
  );
}
