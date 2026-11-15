import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { toElementId } from '../model/ids.ts';
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import { typesOfTable, typeValues, type ElementType } from '../model/types/catalog.ts';
import { starterTypes } from '../model/types/starter.ts';
import { capPilePositions, capSizeFor, capsUnderColumns, maxPileSpacing, padsUnderColumns, pileEdgeCheck, pilesInCap, PILE_COUNTS } from '../model/foundationLayout.ts';
import { getProjectUnits, getUnitSuffix, unitsPerMetreOf } from '../utils/units.ts';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { NumberInput } from './NumberInput.tsx';
import { cn } from '../lib/utils';

const LABEL = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground';
const CELL = 'h-7 w-full rounded-md border border-input bg-transparent px-1.5 text-[11px] tabular-nums';
const BTN = 'rounded-md border border-border bg-transparent px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground';
const CUSTOM = '__custom__';

export type FoundationLayoutMode = 'pads' | 'piles' | 'caps';

/**
 * Batch foundations: pads under the selected columns (sized by a foundation
 * type, or typed sizes), or piles in the selected pile cap by count and
 * spacing (checked against the pile edge distance), or pile caps with
 * their piles under the selected columns. One undo step.
 */
export default function FoundationLayoutDialog({ mode, open, onClose }: { mode: FoundationLayoutMode; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const unit = getUnitSuffix(getProjectUnits(state)).trim();
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const kind = mode === 'pads' ? 'pad' : 'pile';
  const piled = mode !== 'pads';
  // Project types of the kind; the starter ones when the project has none yet.
  const types: ElementType[] = useMemo(() => {
    const own = typesOfTable(state.project?.types, 'foundation_type').filter(x => (x.values.kind || kind) === kind);
    return own.length > 0 ? own : starterTypes(upm).filter(x => x.table === 'foundation_type' && x.values.kind === kind);
  }, [state.project?.types, kind, upm]);
  const [typeId, setTypeId] = useState('');
  const [v, setV] = useState<Record<string, string>>({});

  const selected: CanonicalElement[] = useMemo(() => {
    const doc = state.document;
    if (!doc) return [];
    return [...state.selectedIds].map(id => doc.elements.get(toElementId(id))).filter((e): e is CanonicalElement => !!e);
  }, [state.selectedIds, state.document]);
  const columns = selected.filter(e => (e.tableName === 'structure_column' || e.tableName === 'column') && e.geometry === 'point');
  const cap = selected.find(e => e.tableName === 'foundation' && e.attrs.kind === 'pile_cap' && e.geometry === 'polygon') as PolygonElement | undefined;

  const applyType = (id: string) => {
    setTypeId(id);
    const ty = types.find(x => x.id === id);
    if (!ty) return;
    const tv = typeValues(ty);
    setV(prev => {
      const next: Record<string, string> = { ...prev, width: tv.width ?? '', length: tv.length ?? '', thickness: tv.thickness ?? '', material_grade: tv.material_grade ?? '', material: tv.material ?? 'concrete' };
      if (piled) next.spacing = String(Math.round(3 * (parseFloat(tv.width || '0.6') || 0.6) * 1000) / 1000);
      return next;
    });
  };

  // Esc closes (the canvas keeps focus while the dialog is open)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setV(piled ? { count: '4', spacing: String(1.8 * upm), width: String(0.6 * upm), thickness: String(15 * upm), material: 'concrete', cap_thickness: String(1 * upm) }
      : { width: String(1.5 * upm), length: String(1.5 * upm), thickness: String(0.5 * upm), material: 'concrete' });
    if (types[0]) applyType(types[0].id); else setTypeId(CUSTOM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  if (!open) return null;
  const doc = state.document;
  const set = (k: string, val: string) => { setV(p => ({ ...p, [k]: val })); if (['width', 'length', 'thickness'].includes(k)) setTypeId(CUSTOM); };

  const attrs = (): Record<string, string> => {
    const a: Record<string, string> = { kind, material: v.material || 'concrete', width: v.width ?? '', thickness: v.thickness ?? '' };
    if (mode === 'pads') a.length = v.length ?? '';
    if (v.material_grade) a.material_grade = v.material_grade;
    const ty = types.find(x => x.id === typeId);
    // A project type is referenced; a starter type is only a size preset.
    if (ty && typesOfTable(state.project?.types, 'foundation_type').some(x => x.id === ty.id)) a.type_id = ty.id;
    return a;
  };
  const taken = () => [...(doc?.elements.keys() ?? []), ...state.grids.map(g => g.id)];

  const count = mode === 'piles' ? (cap ? 1 : 0) : columns.length;
  const nPiles = parseInt(v.count || '4', 10) || 4;
  const spacing = parseFloat(v.spacing || '') || 1.8 * upm;
  const diameter = parseFloat(v.width || '') || 0.6 * upm;
  // Edge distance of the piles in the selected cap (pile centre ≥ d and pile rim ≥ 150 mm from the edge)
  const edge = mode === 'piles' && cap ? pileEdgeCheck(cap.vertices, capPilePositions(cap.vertices, nPiles, spacing), diameter, upm) : null;
  const fitSpacing = mode === 'piles' && cap && edge && !edge.ok ? maxPileSpacing(cap.vertices, nPiles, diameter, upm) : 0;
  const capSize = mode === 'caps' ? capSizeFor(nPiles, spacing, diameter, upm) : null;
  const fmt = (x: number) => String(Math.round((x / upm) * 1000) / 1000 * upm);
  const ok = () => {
    if (!doc) return;
    if (mode === 'pads') {
      const pads = padsUnderColumns(columns, doc.elements.values(), attrs(), taken());
      if (pads.length > 0) dispatch({ type: 'CREATE_ELEMENTS', elements: pads, description: `Place ${pads.length} foundations`, selectPrimary: false });
    } else if (mode === 'caps') {
      const capAttrs: Record<string, string> = { material: 'concrete', thickness: v.cap_thickness || String(upm) };
      if (v.material_grade) capAttrs.material_grade = v.material_grade;
      const els = capsUnderColumns(columns, doc.elements.values(), nPiles, spacing, capAttrs, attrs(), taken(), upm);
      if (els.length > 0) dispatch({ type: 'CREATE_ELEMENTS', elements: els, description: `Place ${els.filter(e => e.geometry === 'polygon').length} pile caps`, selectPrimary: false });
    } else if (cap) {
      const { piles, replace } = pilesInCap(cap, nPiles, spacing, attrs(), taken(), doc.elements.values());
      const patches = new Map<string, CanonicalElement | null>(replace.map(id => [id, null]));
      for (const p of piles) patches.set(p.id, p);
      dispatch({ type: 'APPLY_PATCH', description: `Place ${piles.length} piles`, patches });
    }
    onClose();
  };

  const num = (key: string, label: string, step = 0.001) => (
    <div className="min-w-0" key={key} data-testid={`fdn-${key}`}>
      <label className={LABEL}>{label} ({unit})</label>
      <NumberInput className={cn(CELL, 'text-right')} value={v[key] ?? ''} onChange={val => set(key, val)} step={step} min={0} />
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[440px] max-w-[95vw] rounded-xl border border-border bg-card shadow-xl" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') onClose(); }} role="dialog" data-testid="foundation-layout-dialog">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="text-[13px] font-semibold">{t(mode === 'pads' ? 'fdn.padsTitle' : mode === 'caps' ? 'fdn.capsTitle' : 'fdn.pilesTitle')}</div>
          <span className="text-[11px] text-muted-foreground">{t(mode === 'piles' ? 'fdn.capSelected' : 'fdn.columnsSelected', { count })}</span>
          <button type="button" className="ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent" onClick={onClose} aria-label={t('dialog.cancel')}><X className="size-4" /></button>
        </div>
        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          <div className="col-span-3">
            <label className={LABEL}>{t('type.label')}</label>
            <Select value={typeId} onValueChange={x => { if (x) { if (x === CUSTOM) setTypeId(CUSTOM); else applyType(x); } }}>
              <SelectTrigger size="sm" className={cn(CELL, 'justify-between')} data-testid="fdn-type">
                <span className="truncate">{types.find(x => x.id === typeId)?.name ?? t('fdn.custom')}</span>
              </SelectTrigger>
              <SelectContent>
                {types.map(x => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                <SelectItem value={CUSTOM}>{t('fdn.custom')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {piled && (
            <div className="min-w-0">
              <label className={LABEL}>{t('fdn.count')}</label>
              <Select value={v.count ?? '4'} onValueChange={x => { if (x) set('count', x); }}>
                <SelectTrigger size="sm" className={cn(CELL, 'justify-between')} data-testid="fdn-count"><span>{v.count ?? '4'}</span></SelectTrigger>
                <SelectContent>{PILE_COUNTS.map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {piled && num('spacing', t('fdn.spacing'))}
          {num('width', t(mode === 'pads' ? 'field.Width' : 'field.Diameter'))}
          {mode === 'pads' && num('length', t('field.Length'))}
          {num('thickness', t(mode === 'pads' ? 'field.Thickness' : 'field.Pile Length'))}
          <div className="min-w-0">
            <label className={LABEL}>{t('field.Grade')}</label>
            <Input className={CELL} value={v.material_grade ?? ''} onChange={e => setV(p => ({ ...p, material_grade: e.target.value }))} data-testid="fdn-grade" />
          </div>
          {mode === 'caps' && num('cap_thickness', t('fdn.capThickness'))}
          {capSize && (
            <div className="col-span-3 text-[11px] text-muted-foreground" data-testid="fdn-cap-size">
              {t('fdn.capSize', { x: fmt(capSize.x), y: fmt(capSize.y), unit })}
            </div>
          )}
          {edge && !edge.ok && (
            <div className="col-span-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300" data-testid="fdn-edge-warning">
              <span className="flex-1">{edge.outside > 0
                ? t('fdn.edgeOutside', { count: edge.outside })
                : t('fdn.edgeTooClose', { least: fmt(edge.least), required: fmt(edge.required), unit })}</span>
              {fitSpacing > 0 && (
                <button type="button" className={BTN} data-testid="fdn-fit-spacing" onClick={() => set('spacing', fmt(fitSpacing))}>
                  {t('fdn.fitSpacing', { spacing: fmt(fitSpacing), unit })}
                </button>
              )}
              {fitSpacing === 0 && <span>{t('fdn.capTooSmall')}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground">{t(mode === 'pads' ? 'fdn.padsHint' : mode === 'caps' ? 'fdn.capsHint' : 'fdn.pilesHint')}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={onClose}>{t('dialog.cancel')}</button>
            <button type="button" disabled={count === 0 || (!!edge && edge.outside > 0)} onClick={ok} data-testid="fdn-ok"
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50">{t('type.ok')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
