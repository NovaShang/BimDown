/**
 * Sheet checks (global/sheet.csv + global/sheet_viewport.csv) beyond the
 * generic header, enum and reference validation: unique sheet numbers, dates,
 * and each viewport naming what it shows (a plan's level, a section of
 * global/view.csv or an elevation direction, a schedule), a positive scale
 * and a centre on its sheet's paper.
 */
import type { CsvData } from '../utils/csv.js';
import type { IdRegistry } from './ids.js';
import { ELEVATION_VIEW_IDS } from './annotations.js';

/** ISO 216 landscape paper, mm. */
export const SHEET_PAPER: Record<string, { w: number; h: number }> = {
  A0: { w: 1189, h: 841 }, A1: { w: 841, h: 594 }, A2: { w: 594, h: 420 }, A3: { w: 420, h: 297 }, A4: { w: 297, h: 210 },
};

export function validateSheets(sheets: CsvData | null, viewports: CsvData | null, registry: IdRegistry): string[] {
  const issues: string[] = [];
  const paperOf = new Map<string, { w: number; h: number }>();
  if (sheets) {
    const numbers = new Map<string, number>();
    sheets.rows.forEach((row, i) => {
      const at = `global/sheet.csv:${i + 2}`;
      paperOf.set(row.id, SHEET_PAPER[row.paper || 'A1'] ?? SHEET_PAPER.A1);
      for (const f of ['revision_date', 'issue_date']) {
        const v = row[f] ?? '';
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) issues.push(`${at}  ${f}="${v}" is not a YYYY-MM-DD date`);
      }
      const n = (row.number ?? '').trim();
      if (!n) return;
      const prev = numbers.get(n);
      if (prev) issues.push(`${at}  sheet number "${n}" is already used on line ${prev}`);
      else numbers.set(n, i + 2);
    });
  }
  if (!viewports) return issues;
  viewports.rows.forEach((row, i) => {
    const at = `global/sheet_viewport.csv:${i + 2}`;
    const type = row.view_type;
    const viewId = (row.view_id ?? '').trim();
    if (type === 'plan' && !row.level_id) issues.push(`${at}  a plan viewport needs level_id`);
    if (type === 'section') {
      if (!viewId) issues.push(`${at}  a section viewport needs view_id (a section of global/view.csv)`);
      else if (registry.allIds.get(viewId)?.table !== 'view') issues.push(`${at}  view_id "${viewId}" is not a section of global/view.csv`);
    }
    if (type === 'elevation' && !ELEVATION_VIEW_IDS.includes(viewId)) {
      issues.push(`${at}  an elevation viewport needs view_id north, south, east or west`);
    }
    if (type === 'schedule' && !row.schedule) issues.push(`${at}  a schedule viewport needs schedule`);
    const scale = row.scale ?? '';
    if (scale !== '' && !(Number.isInteger(Number(scale)) && Number(scale) > 0)) {
      issues.push(`${at}  scale="${scale}" must be a positive whole number (100 = 1:100)`);
    }
    for (const f of ['x', 'y']) {
      const v = row[f];
      if (v !== undefined && v !== '' && !Number.isFinite(Number(v))) issues.push(`${at}  ${f}="${v}" is not a number`);
    }
    const paper = paperOf.get(row.sheet_id);
    const x = Number(row.x), y = Number(row.y);
    if (paper && row.x !== '' && row.y !== '' && Number.isFinite(x) && Number.isFinite(y) && (x < 0 || y < 0 || x > paper.w || y > paper.h)) {
      issues.push(`${at}  centre (${x}, ${y}) mm is off its ${paper.w}×${paper.h} mm sheet`);
    }
  });
  return issues;
}
