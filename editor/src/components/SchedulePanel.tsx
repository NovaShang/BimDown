import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { LAYER_STYLES } from '../types.ts';
import { getProjectUnits } from '../utils/units.ts';
import { triggerDownload } from '../export/download.ts';
import {
  SCHEDULES, scheduleRows, sortRows, groupRows, totalsOf, formatCell, unitSuffix, scheduleCsv,
  type ScheduleCategory, type SortState,
} from '../schedule/schedules.ts';
import { buildXlsx, type XlsxCell } from '../schedule/xlsx.ts';
import { elementBounds } from '../schedule/quantities.ts';
import { toElementId } from '../model/ids.ts';
import { parseLayer } from '../model/parse.ts';
import { Icon } from './Icons.tsx';
import { cn } from '../lib/utils';

/** Event a host app (or the top bar) fires to open/close the schedule view. */
export const SCHEDULE_TOGGLE_EVENT = 'bimdown:toggle-schedule';
/** Canvas listens for this to zoom the plan to a model-space box. */
export const ZOOM_TO_EVENT = 'bimdown:zoom-to';

interface Config { columns: string[]; groupBy: string; sort: SortState }

function defaultConfig(cat: ScheduleCategory): Config {
  return { columns: cat.columns.filter(c => c.defaultOn !== false).map(c => c.key), groupBy: cat.groupBy ?? '', sort: null };
}

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'schedule';

/**
 * Schedule view: element lists per category across all levels with
 * configurable columns, grouping with subtotals, totals and sorting. A row
 * click selects the element in the plan (switching level when needed).
 * Quantities follow `bimdown build` (see schedule/quantities.ts).
 */
export default function SchedulePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const unit = getProjectUnits(state);
  const [catKey, setCatKey] = useState(SCHEDULES[0].key);
  const [configs, setConfigs] = useState<Record<string, Config>>({});
  const [showColumns, setShowColumns] = useState(false);
  const cat = SCHEDULES.find(c => c.key === catKey)!;
  const config = configs[catKey] ?? defaultConfig(cat);
  const setConfig = (patch: Partial<Config>) => setConfigs(prev => ({ ...prev, [catKey]: { ...config, ...patch } }));

  const displayName = (table: string) => {
    const s = LAYER_STYLES[table];
    return s ? t(`display.${s.displayName}`) : table;
  };

  const rows = useMemo(() => {
    if (!state.project) return [];
    return scheduleRows(cat, state.project, unit, displayName, state.document?.levelId, state.document?.elements);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, state.project, state.document, state.documentVersion, unit, t]);

  const columns = cat.columns.filter(c => config.columns.includes(c.key));
  const groups = groupRows(sortRows(rows, config.sort), config.groupBy, columns);
  const grand = totalsOf(rows, columns);
  const header = columns.map(c => {
    const u = unitSuffix(c.kind, unit);
    return u ? `${t(c.label)} (${u})` : t(c.label);
  });

  const select = (sid: string, levelId: string) => {
    const raw = toElementId(sid);
    const zoom = (el: Parameters<typeof elementBounds>[0] | undefined) => {
      if (!el) return;
      const b = elementBounds(el);
      const pad = 3;
      const h = Math.max(b.maxY - b.minY, 6) + 2 * pad;
      // The panel covers the lower part of the canvas: extend the box downwards
      // so the element lands in the visible upper part
      window.dispatchEvent(new CustomEvent(ZOOM_TO_EVENT, { detail: { minX: b.minX - pad - 4, minY: b.minY - pad - h * 0.9, maxX: b.maxX + pad + 4, maxY: b.maxY + pad } }));
    };
    if (levelId === 'global') {
      dispatch({ type: 'SELECT', ids: [sid] });
      for (const gl of state.project?.globalLayers ?? []) zoom(parseLayer(gl).find(e => e.id === raw));
      return;
    }
    if (levelId !== state.currentLevel) {
      dispatch({ type: 'SET_LEVEL', levelId });
      // The plan re-initialises its document for the new level on the next render
      setTimeout(() => {
        dispatch({ type: 'SELECT', ids: [sid] });
        const floor = state.project?.floors.get(levelId);
        if (floor) for (const l of floor.layers) zoom(parseLayer(l).find(e => e.id === raw));
      }, 50);
      return;
    }
    dispatch({ type: 'SELECT', ids: [sid] });
    zoom(state.document?.elements.get(raw));
  };

  const exportCsv = () => {
    const csv = scheduleCsv(groups, columns, header, t('schedule.total'));
    triggerDownload(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${fileSafe(state.modelName)}-${cat.key}.csv`);
  };
  const exportXlsx = async () => {
    // One sheet per schedule with the user's columns / grouping for each
    const sheets = SCHEDULES.map(c => {
      const cfg = configs[c.key] ?? defaultConfig(c);
      const cols = c.columns.filter(col => cfg.columns.includes(col.key));
      const all = state.project ? scheduleRows(c, state.project, unit, displayName, state.document?.levelId, state.document?.elements) : [];
      if (all.length === 0) return null;
      const gs = groupRows(sortRows(all, cfg.sort), cfg.groupBy, cols);
      const out: XlsxCell[][] = [cols.map(col => {
        const u = unitSuffix(col.kind, unit);
        return u ? `${t(col.label)} (${u})` : t(col.label);
      })];
      const bold = [0];
      for (const g of gs) {
        for (const r of g.rows) out.push(cols.map(col => r.values[col.key] ?? ''));
        if (gs.length > 1) {
          bold.push(out.length);
          out.push(cols.map((col, i) => (i === 0 ? `${t('schedule.total')}: ${g.key || '—'}` : col.total ? g.totals[col.key] : '')));
        }
      }
      const tot = totalsOf(all, cols);
      bold.push(out.length);
      out.push(cols.map((col, i) => (i === 0 ? t('schedule.total') : col.total ? tot[col.key] : '')));
      return { name: t(c.label), rows: out, boldRows: bold };
    }).filter((s): s is NonNullable<typeof s> => s !== null);
    if (sheets.length === 0) return;
    triggerDownload(await buildXlsx(sheets), `${fileSafe(state.modelName)}-schedules.xlsx`);
  };

  const toggleSort = (key: string) => {
    const s = config.sort;
    setConfig({ sort: !s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null });
  };

  const selectedRaw = new Set([...state.selectedIds]);

  return (
    <div data-testid="schedule-panel" data-canvas-overlay="bottom"
      className="absolute inset-x-3 bottom-3 z-40 flex h-[44%] min-h-[220px] flex-col overflow-hidden glass-panel rounded-xl border border-border shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* Header: categories + actions */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Icon name="schedule" width={16} height={16} className="text-muted-foreground" />
        <span className="mr-1 text-[11px] font-semibold">{t('schedule.title')}</span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {SCHEDULES.map(c => (
            <button key={c.key}
              className={cn('h-6 shrink-0 rounded-md px-2 text-[11px] transition-colors',
                c.key === catKey ? 'bg-[var(--accent-dim)] font-medium text-[var(--color-accent)]' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
              onClick={() => { setCatKey(c.key); setShowColumns(false); }}>
              {t(c.label)}
            </button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          {t('schedule.groupBy')}
          <select className="h-6 rounded-md border border-input bg-transparent px-1 text-[11px] text-foreground"
            value={config.groupBy} onChange={e => setConfig({ groupBy: e.target.value })} data-testid="schedule-group">
            <option value="">{t('schedule.noGrouping')}</option>
            {cat.columns.filter(c => c.kind === 'text').map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
          </select>
        </label>
        <div className="relative shrink-0">
          <button className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setShowColumns(v => !v)} data-testid="schedule-columns">{t('schedule.columnsBtn')}</button>
          {showColumns && (
            <div className="absolute right-0 top-7 z-50 min-w-40 rounded-lg border border-border bg-popover p-1 shadow-lg">
              {cat.columns.map(c => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-accent">
                  <input type="checkbox" checked={config.columns.includes(c.key)}
                    onChange={e => setConfig({ columns: e.target.checked ? cat.columns.map(x => x.key).filter(k => k === c.key || config.columns.includes(k)) : config.columns.filter(k => k !== c.key) })} />
                  {t(c.label)}
                </label>
              ))}
            </div>
          )}
        </div>
        <button className="h-6 shrink-0 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={exportCsv} data-testid="schedule-csv">CSV</button>
        <button className="h-6 shrink-0 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { void exportXlsx(); }} data-testid="schedule-xlsx">XLSX</button>
        <button className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} title={t('schedule.close')}>✕</button>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">{t('schedule.empty')}</div>
        ) : (
          <table className="w-full border-collapse text-[11px] tabular-nums" data-testid="schedule-table">
            <thead className="sticky top-0 z-10 bg-[var(--panel-bg,var(--background))]">
              <tr>
                {columns.map((c, i) => (
                  <th key={c.key} onClick={() => toggleSort(c.key)}
                    className={cn('cursor-pointer select-none whitespace-nowrap border-b border-border px-2 py-1 font-medium text-muted-foreground hover:text-foreground',
                      c.kind === 'text' ? 'text-left' : 'text-right')}>
                    {header[i]}{config.sort?.key === c.key ? (config.sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <GroupRows key={g.key} group={g} columns={columns} unit={unit} grouped={!!config.groupBy}
                  groupLabel={`${t(cat.columns.find(c => c.key === config.groupBy)?.label ?? '')}: ${g.key || '—'}`}
                  selected={selectedRaw} onSelect={select} totalLabel={t('schedule.subtotal')} />
              ))}
              <tr className="sticky bottom-0 bg-[var(--panel-bg,var(--background))] font-semibold">
                {columns.map((c, i) => (
                  <td key={c.key} className={cn('border-t border-border px-2 py-1', c.kind === 'text' ? 'text-left' : 'text-right')}>
                    {i === 0 ? `${t('schedule.total')} (${rows.length})` : c.total ? formatCell(grand[c.key], c.kind, unit) : ''}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function GroupRows({ group, columns, unit, grouped, groupLabel, selected, onSelect, totalLabel }: {
  group: ReturnType<typeof groupRows>[number];
  columns: ScheduleCategory['columns'];
  unit: ReturnType<typeof getProjectUnits>;
  grouped: boolean;
  groupLabel: string;
  selected: Set<string>;
  onSelect: (sid: string, levelId: string) => void;
  totalLabel: string;
}) {
  return (
    <>
      {grouped && (
        <tr className="bg-foreground/[0.04]">
          <td colSpan={columns.length} className="px-2 py-1 text-[10px] font-semibold text-foreground/70">{groupLabel} · {group.rows.length}</td>
        </tr>
      )}
      {group.rows.map(r => (
        <tr key={r.sid} data-sid={r.sid}
          className={cn('cursor-pointer hover:bg-accent/60', selected.has(r.sid) && 'bg-[var(--accent-dim)]')}
          onClick={() => onSelect(r.sid, r.levelId)}>
          {columns.map(c => (
            <td key={c.key} className={cn('whitespace-nowrap border-b border-border/30 px-2 py-[3px]', c.kind === 'text' ? 'text-left' : 'text-right')}>
              {formatCell(r.values[c.key], c.kind, unit)}
            </td>
          ))}
        </tr>
      ))}
      {grouped && columns.some(c => c.total) && (
        <tr className="text-foreground/70">
          {columns.map((c, i) => (
            <td key={c.key} className={cn('border-b border-border/60 px-2 py-[3px] italic', c.kind === 'text' ? 'text-left' : 'text-right')}>
              {i === 0 ? totalLabel : c.total ? formatCell(group.totals[c.key], c.kind, unit) : ''}
            </td>
          ))}
        </tr>
      )}
    </>
  );
}
