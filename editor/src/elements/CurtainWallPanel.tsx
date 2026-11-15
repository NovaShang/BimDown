/**
 * Curtain wall properties-panel editor (ElementModule.propertyPanel): an
 * elevation of the grid (click cells to set their panel kind), the vertical /
 * horizontal grid line lists (add, remove, move) and the mullion parameters.
 * Every edit is one UPDATE_ATTRS (one undo step).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { PropertyPanelProps } from './archetypes.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { Select, SelectTrigger, SelectContent, SelectItem } from '../components/ui/select';
import { NumberInput } from '../components/NumberInput.tsx';
import { MATERIAL_OPTIONS, SHAPE_OPTIONS } from './_options.ts';
import { cn } from '../lib/utils';
import {
  DEFAULT_MULLION, DEFAULT_SOLID_MATERIAL, PANEL_KINDS, curtainGrid, insertGridLine, moveGridLine,
  removeGridLine, setPanelKinds, uniformGrid, type GridAxis, type PanelKind,
} from './curtainWallLayout.ts';

const DEFAULT_HEIGHT = 3.0;
const DIAGRAM_W = 200;
const DIAGRAM_MAX_H = 150;

const KIND_FILL: Record<PanelKind, string> = {
  glass: '#cfe8f6', solid: '#9aa3ad', door: '#cfe8f6', double_door: '#cfe8f6', empty: 'transparent',
};

const INPUT = 'h-[22px] w-[64px] rounded-md border border-border/60 bg-transparent px-1.5 text-right text-[11px] tabular-nums';
const BTN = 'inline-flex h-[22px] items-center gap-1 rounded-md border border-border/60 px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const SECTION = 'mt-2 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground';

type Cell = { col: number; row: number };

export default function CurtainWallPanel({ element, editable }: PropertyPanelProps) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const [selected, setSelected] = useState<Cell[]>([]);

  const levels = state.project?.levels ?? [];
  const attrs = element.attrs;
  const length = element.geometry === 'line' || element.geometry === 'spatial_line'
    ? Math.hypot(element.end.x - element.start.x, element.end.y - element.start.y) : 0;
  const height = useMemo(() => {
    const base = levels.find(l => l.id === state.currentLevel)?.elevation ?? 0;
    const top = levels.find(l => l.id === attrs.top_level_id)?.elevation;
    if (top === undefined) return DEFAULT_HEIGHT;
    return Math.max(0.01, top + (parseFloat(attrs.top_offset || '0') || 0) - (base + (parseFloat(attrs.base_offset || '0') || 0)));
  }, [levels, state.currentLevel, attrs.top_level_id, attrs.top_offset, attrs.base_offset]);
  const grid = useMemo(() => curtainGrid(attrs, length, height), [attrs, length, height]);
  if (length < 0.001) return null;

  const cols = grid.xs.length - 1, rows = grid.ys.length - 1;
  const cells = selected.filter(c => c.col < cols && c.row < rows);
  const apply = (patch: Record<string, string> | null) => {
    if (patch && editable) dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: patch });
  };

  // Elevation diagram, bottom row at the bottom.
  const s = Math.min(DIAGRAM_W / length, DIAGRAM_MAX_H / height);
  const W = length * s, H = height * s;
  const toX = (x: number) => x * s;
  const toY = (y: number) => H - y * s;
  const isSel = (col: number, row: number) => cells.some(c => c.col === col && c.row === row);
  const pick = (col: number, row: number, add: boolean) => {
    setSelected(prev => {
      const has = prev.some(c => c.col === col && c.row === row);
      if (!add) return has && prev.length === 1 ? [] : [{ col, row }];
      return has ? prev.filter(c => c.col !== col || c.row !== row) : [...prev, { col, row }];
    });
  };
  const kindOfSelection = cells.length > 0 && cells.every(c => grid.kinds[c.col][c.row] === grid.kinds[cells[0].col][cells[0].row])
    ? grid.kinds[cells[0].col][cells[0].row] : null;

  const addLine = (axis: GridAxis) => {
    // Split the widest cell in half.
    const b = axis === 'v' ? grid.xs : grid.ys;
    let k = 0;
    for (let i = 1; i < b.length - 1; i++) if (b[i + 1] - b[i] > b[k + 1] - b[k]) k = i;
    apply(insertGridLine(grid, axis, (b[k] + b[k + 1]) / 2));
    setSelected([]);
  };

  const lineList = (axis: GridAxis) => {
    const b = axis === 'v' ? grid.xs : grid.ys;
    const lines = b.slice(1, -1);
    return (
      <div data-testid={`cw-${axis}-grids`}>
        <div className="flex items-center gap-1">
          <div className={cn(SECTION, 'flex-1')}>{t(axis === 'v' ? 'cw.vGrids' : 'cw.uGrids')}</div>
          <button type="button" className={BTN} disabled={!editable} onClick={() => addLine(axis)} data-testid={`cw-add-${axis}`}>
            <Plus className="size-3" />{t('cw.add')}
          </button>
        </div>
        {lines.length === 0 && <div className="text-[10px] text-muted-foreground/60">{t('cw.noLines')}</div>}
        <div className="flex flex-wrap gap-1">
          {lines.map((v, i) => (
            <div key={`${axis}${i}`} className="flex items-center">
              <NumberInput className={INPUT} value={String(Math.round(v * 1000) / 1000)} disabled={!editable} testId={`cw-${axis}-line-${i}`}
                onCommit={val => apply(moveGridLine(grid, axis, i, parseFloat(val)))} />
              <button type="button" className="inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                title={t('cw.remove')} aria-label={t('cw.remove')} disabled={!editable}
                onClick={() => { apply(removeGridLine(grid, axis, i)); setSelected([]); }} data-testid={`cw-remove-${axis}-${i}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const doorMark = (i: number, j: number, double: boolean) => {
    // Elevation swing mark: lines from the hinge jamb to the latch-side corners.
    const x0 = toX(grid.xs[i]) + 2, x1 = toX(grid.xs[i + 1]) - 2, y0 = toY(grid.ys[j]), y1 = toY(grid.ys[j + 1]) + 2;
    const leaf = (h: number, l: number) => `M ${l},${y0} L ${h},${(y0 + y1) / 2} L ${l},${y1}`;
    const d = double ? `${leaf(x0, (x0 + x1) / 2)} ${leaf(x1, (x0 + x1) / 2)}` : leaf(x0, x1);
    return <path d={d} fill="none" stroke="#5b6b7a" strokeWidth={0.8} pointerEvents="none" />;
  };

  return (
    <div className="border-b border-border/50 px-3 py-2" data-testid="cw-panel">
      <div className="flex items-center gap-1">
        <div className="flex-1 text-[11px] font-semibold">{t('cw.title')}</div>
        <button type="button" className={BTN} disabled={!editable || (!grid.explicitV && !grid.explicitU)}
          title={t('cw.uniformHint')} onClick={() => apply(uniformGrid(grid))} data-testid="cw-uniform">{t('cw.uniform')}</button>
        <button type="button" className={BTN} disabled={!editable || !attrs.panels}
          onClick={() => { apply({ panels: '' }); setSelected([]); }} data-testid="cw-all-glass">{t('cw.allGlass')}</button>
      </div>

      <svg viewBox={`-1 -1 ${W + 2} ${H + 2}`} style={{ width: `min(100%, ${W + 2}px)` }} className="mt-1.5 block h-auto" data-testid="cw-elevation">
        {grid.kinds.map((col, i) => col.map((k, j) => (
          <rect key={`${i}_${j}`} data-testid={`cw-cell-${i}-${j}`}
            x={toX(grid.xs[i])} y={toY(grid.ys[j + 1])} width={toX(grid.xs[i + 1]) - toX(grid.xs[i])} height={toY(grid.ys[j]) - toY(grid.ys[j + 1])}
            fill={KIND_FILL[k]} stroke={isSel(i, j) ? 'var(--color-accent, #3a7bff)' : 'none'} strokeWidth={isSel(i, j) ? 2 : 0}
            className="cursor-pointer" onClick={e => pick(i, j, e.shiftKey || e.metaKey || e.ctrlKey)}>
            <title>{`${i}:${j} ${t(`cw.kind.${k}`)}`}</title>
          </rect>
        )))}
        {grid.kinds.map((col, i) => col.map((k, j) => {
          if (k === 'door' || k === 'double_door') return <g key={`d${i}_${j}`}>{doorMark(i, j, k === 'double_door')}</g>;
          if (k !== 'empty') return null;
          const x0 = toX(grid.xs[i]), x1 = toX(grid.xs[i + 1]), y0 = toY(grid.ys[j]), y1 = toY(grid.ys[j + 1]);
          return <path key={`e${i}_${j}`} d={`M ${x0},${y0} L ${x1},${y1} M ${x0},${y1} L ${x1},${y0}`} stroke="#9ca3af" strokeWidth={0.6} strokeDasharray="2 2" pointerEvents="none" />;
        }))}
        {grid.xs.map((x, i) => (
          <line key={`v${i}`} x1={toX(x)} x2={toX(x)} y1={0} y2={H} stroke="#4b5563" strokeWidth={i === 0 || i === cols ? 1.5 : 1} pointerEvents="none" />
        ))}
        {grid.ys.map((y, j) => (
          <line key={`u${j}`} x1={0} x2={W} y1={toY(y)} y2={toY(y)} stroke="#4b5563" strokeWidth={j === 0 || j === rows ? 1.5 : 1} pointerEvents="none" />
        ))}
      </svg>
      <div className="mt-1 text-[10px] text-muted-foreground">{t('cw.pickCell')}</div>
      <div className="mt-1 flex flex-wrap gap-1" data-testid="cw-kinds">
        {PANEL_KINDS.map(k => (
          <button key={k} type="button" disabled={!editable || cells.length === 0}
            className={cn(BTN, kindOfSelection === k && 'border-[var(--color-accent)] text-foreground')}
            onClick={() => apply(setPanelKinds(grid, cells, k))} data-testid={`cw-kind-${k}`}>
            {t(`cw.kind.${k}`)}
          </button>
        ))}
      </div>

      {lineList('v')}
      {lineList('u')}

      <div className={SECTION}>{t('cw.mullions')}</div>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span>{t('cw.mullionWidth')}</span>
        <NumberInput className={INPUT} value={attrs.mullion_width ?? ''} placeholder={String(DEFAULT_MULLION)} allowEmpty disabled={!editable}
          onCommit={v => apply({ mullion_width: v })} />
        <span>{t('cw.mullionDepth')}</span>
        <NumberInput className={INPUT} value={attrs.mullion_depth ?? ''} placeholder={String(DEFAULT_MULLION)} allowEmpty disabled={!editable}
          onCommit={v => apply({ mullion_depth: v })} />
        <span>{t('cw.mullionProfile')}</span>
        <Select value={attrs.mullion_profile || 'rect'} onValueChange={v => { if (v) apply({ mullion_profile: v }); }} disabled={!editable}>
          <SelectTrigger size="sm" className={cn(INPUT, 'w-[88px] justify-between')} data-testid="cw-profile">
            <span className="truncate">{t(`option.${SHAPE_OPTIONS!.find(o => o.value === (attrs.mullion_profile || 'rect'))?.label ?? 'Rect'}`)}</span>
          </SelectTrigger>
          <SelectContent>
            {SHAPE_OPTIONS!.map(o => <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        <span>{t('cw.solidMaterial')}</span>
        <Select value={attrs.solid_material || DEFAULT_SOLID_MATERIAL} onValueChange={v => { if (v) apply({ solid_material: v }); }} disabled={!editable}>
          <SelectTrigger size="sm" className={cn(INPUT, 'w-[88px] justify-between')} data-testid="cw-solid-material">
            <span className="truncate">{(() => {
              const v = attrs.solid_material || DEFAULT_SOLID_MATERIAL;
              const o = MATERIAL_OPTIONS!.find(o => o.value === v);
              return o ? t(`option.${o.label}`, o.label) : v;
            })()}</span>
          </SelectTrigger>
          <SelectContent>
            {MATERIAL_OPTIONS!.map(o => <SelectItem key={o.value} value={o.value}>{t(`option.${o.label}`, o.label)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
