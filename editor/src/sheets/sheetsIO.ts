/** global/sheet.csv + global/sheet_viewport.csv ↔ SheetSet. */
import type { CsvRow } from '../types.ts';
import type { DrawingDiscipline } from '../export/drawing/types.ts';
import {
  SHEET_PAPERS, DEFAULT_PAPER, type SheetDef, type SheetPaper, type SheetSet, type ViewportDef, type ViewportType,
} from './sheetTypes.ts';

export const SHEET_CSV_PATH = 'global/sheet.csv';
export const VIEWPORT_CSV_PATH = 'global/sheet_viewport.csv';

const SHEET_HEADER = 'id,number,name,paper,revision,revision_date,revision_note,issue_date,drawn_by,checked_by';
const VIEWPORT_HEADER = 'id,sheet_id,view_type,level_id,view_id,schedule,discipline,scale,x,y,title,crop_min_x,crop_min_y,crop_max_x,crop_max_y';

const VIEWPORT_TYPES = new Set<ViewportType>(['plan', 'section', 'elevation', 'schedule', 'legend']);
const DISCIPLINES = new Set<DrawingDiscipline>(['architecture', 'structure', 'mep', 'all']);

export function sheetsFromRows(rows: CsvRow[]): SheetDef[] {
  return rows.filter(r => r.id).map(r => ({
    id: r.id,
    number: r.number || r.id,
    name: r.name || '',
    paper: (r.paper && r.paper in SHEET_PAPERS ? r.paper : DEFAULT_PAPER) as SheetPaper,
    revision: r.revision || '',
    revisionDate: r.revision_date || '',
    revisionNote: r.revision_note || '',
    issueDate: r.issue_date || '',
    drawnBy: r.drawn_by || '',
    checkedBy: r.checked_by || '',
  }));
}

/** crop_min_x … crop_max_y, all four finite and a non-empty box. */
function cropOf(r: CsvRow): Pick<ViewportDef, 'crop'> {
  const [x0, y0, x1, y1] = ['crop_min_x', 'crop_min_y', 'crop_max_x', 'crop_max_y'].map(k => parseFloat(r[k] ?? ''));
  return [x0, y0, x1, y1].every(Number.isFinite) && x1 > x0 && y1 > y0 ? { crop: { minX: x0, minY: y0, maxX: x1, maxY: y1 } } : {};
}

export function viewportsFromRows(rows: CsvRow[]): ViewportDef[] {
  const out: ViewportDef[] = [];
  for (const r of rows) {
    if (!r.id || !r.sheet_id || !VIEWPORT_TYPES.has(r.view_type as ViewportType)) continue;
    const x = parseFloat(r.x), y = parseFloat(r.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const scale = parseInt(r.scale, 10);
    out.push({
      id: r.id,
      sheetId: r.sheet_id,
      type: r.view_type as ViewportType,
      levelId: r.level_id || '',
      viewId: r.view_id || '',
      schedule: r.schedule || '',
      discipline: (DISCIPLINES.has(r.discipline as DrawingDiscipline) ? r.discipline : 'architecture') as DrawingDiscipline,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 100,
      x, y,
      title: r.title || '',
      ...cropOf(r),
    });
  }
  return out;
}

function esc(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const num = (v: number) => String(Math.round(v * 100) / 100);

export function sheetsToCsv(sheets: SheetDef[]): string {
  const rows = sheets.map(s => [
    s.id, esc(s.number), esc(s.name), s.paper, esc(s.revision), s.revisionDate, esc(s.revisionNote),
    s.issueDate, esc(s.drawnBy), esc(s.checkedBy),
  ].join(','));
  return [SHEET_HEADER, ...rows].join('\n') + '\n';
}

export function viewportsToCsv(viewports: ViewportDef[]): string {
  const rows = viewports.map(v => [
    v.id, v.sheetId, v.type,
    v.type === 'plan' ? v.levelId : '',
    v.type === 'section' || v.type === 'elevation' ? v.viewId : '',
    v.type === 'schedule' ? v.schedule : '',
    v.type === 'plan' ? v.discipline : '',
    v.type === 'schedule' || v.type === 'legend' ? '' : String(v.scale),
    num(v.x), num(v.y), esc(v.title),
    ...(v.crop && v.type !== 'schedule' && v.type !== 'legend'
      ? [v.crop.minX, v.crop.minY, v.crop.maxX, v.crop.maxY].map(n => String(Math.round(n * 1e6) / 1e6))
      : ['', '', '', '']),
  ].join(','));
  return [VIEWPORT_HEADER, ...rows].join('\n') + '\n';
}

function nextId(prefix: string, used: Iterable<string>): string {
  const set = new Set(used);
  let n = 1;
  while (set.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export const nextSheetId = (set: SheetSet) => nextId('sh', set.sheets.map(s => s.id));
export const nextViewportId = (set: SheetSet) => nextId('vp', set.viewports.map(v => v.id));

/** Sheet number prefix per discipline (US NCS): A- architecture, S- structure, M- MEP. */
export const SHEET_PREFIX: Record<string, string> = { architecture: 'A-', structure: 'S-', mep: 'M-' };

/**
 * Next sheet number after the highest one with the same prefix ("A-101" →
 * "A-102"); with a discipline, after the highest of that discipline's prefix
 * (S-101 for the first structural sheet).
 */
export function nextSheetNumber(sheets: SheetDef[], discipline?: string | null): string {
  const used = new Set(sheets.map(s => s.number));
  const prefix = discipline ? SHEET_PREFIX[discipline] : undefined;
  if (prefix) {
    let max = 100;
    for (const s of sheets) {
      if (!s.number.startsWith(prefix)) continue;
      const n = parseInt(s.number.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    let n = max + 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
  const last = sheets[sheets.length - 1]?.number ?? '';
  const m = /^(.*?)(\d+)$/.exec(last);
  if (m) {
    let n = parseInt(m[2], 10) + 1;
    for (;;) {
      const s = `${m[1]}${String(n).padStart(m[2].length, '0')}`;
      if (!used.has(s)) return s;
      n++;
    }
  }
  let n = 101;
  while (used.has(`A-${n}`)) n++;
  return `A-${n}`;
}

export function newSheet(set: SheetSet, paper: SheetPaper = DEFAULT_PAPER, discipline?: string | null): SheetDef {
  return {
    id: nextSheetId(set), number: nextSheetNumber(set.sheets, discipline), name: '', paper,
    revision: '', revisionDate: '', revisionNote: '', issueDate: '', drawnBy: '', checkedBy: '',
  };
}

/** Sheets with their viewports (a viewport of a missing sheet is dropped). */
export function sheetSetFromRows(sheetRows: CsvRow[], viewportRows: CsvRow[]): SheetSet {
  const sheets = sheetsFromRows(sheetRows);
  const ids = new Set(sheets.map(s => s.id));
  return { sheets, viewports: viewportsFromRows(viewportRows).filter(v => ids.has(v.sheetId)) };
}
