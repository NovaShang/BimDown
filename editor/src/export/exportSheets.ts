/**
 * Sheet set export: every sheet of global/sheet.csv as one page of a PDF (its
 * own paper size, landscape), or one DXF per sheet in paper millimetres (1:1,
 * plot-ready; views at their viewport scale, text at paper height) zipped
 * when there are several. The composition is drawing/sheetCompose.ts; Chinese
 * text switches the PDF to the embedded Noto Sans SC subset.
 */
import type { CanonicalElement } from '../model/elements.ts';
import type { GridData, ProjectData } from '../types.ts';
import type { SheetDef, SheetSet } from '../sheets/sheetTypes.ts';
import { triggerDownload } from './download.ts';
import { composeSheet, flattenSheet, sheetTexts, SheetDrawings, type ComposedSheet } from './drawing/sheetCompose.ts';
import { drawingLang } from './drawing/labels.ts';
import { needsUnicodeFont, loadUnicodeFont, CJK_FONT_FILE, CJK_FONT_NAME, type FontLoader } from './drawing/pdfFont.ts';
import { ItemPainter, type Fonts } from './drawing/pdfPaint.ts';
import { planToDxf } from './exportDxf.ts';

export interface SheetExportOptions {
  grids?: GridData[];
  /** Sheet language (`en` / `zh`), default the UI language. */
  lang?: string;
  projectName?: string;
  date?: Date;
  /** Only these sheets (ids), in set order; default all. */
  sheetIds?: string[];
  live?: { levelId: string; elements: CanonicalElement[] };
  fontLoader?: FontLoader;
  /** Reuse the editor's drawing cache. */
  drawings?: SheetDrawings;
}

function chosen(set: SheetSet, ids?: string[]): SheetDef[] {
  return ids ? set.sheets.filter(s => ids.includes(s.id)) : set.sheets;
}

export function composeSheets(project: ProjectData, opts: SheetExportOptions = {}): ComposedSheet[] {
  const set = project.sheets ?? { sheets: [], viewports: [] };
  const drawings = opts.drawings ?? new SheetDrawings({
    project, grids: opts.grids ?? [], lang: drawingLang(opts.lang), date: opts.date ?? new Date(),
    projectName: opts.projectName, live: opts.live,
  });
  return chosen(set, opts.sheetIds).map(s => composeSheet(s, set, drawings));
}

export interface SheetPdfResult { bytes: ArrayBuffer; pages: number }

/** The sheet set as one PDF; null when there are no sheets. */
export async function buildSheetSetPdf(project: ProjectData, modelName: string, opts: SheetExportOptions = {}): Promise<SheetPdfResult | null> {
  const sheets = composeSheets(project, opts);
  if (!sheets.length) return null;
  const fonts: Fonts = { unicode: needsUnicodeFont([...sheetTexts(sheets), modelName]) };
  const { jsPDF } = await import('jspdf');
  const first = sheets[0].frame.paper;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [first.w, first.h], compress: true });
  if (fonts.unicode) {
    doc.addFileToVFS(CJK_FONT_FILE, await loadUnicodeFont(opts.fontLoader));
    doc.addFont(CJK_FONT_FILE, CJK_FONT_NAME, 'normal');
  }
  const projectName = opts.projectName || project.metadata.project_name || modelName;
  doc.setProperties({ title: `${projectName} — ${sheets.map(s => s.sheet.number).join(', ')}`, creator: 'BimDown (bim.jouledown.com)' });
  sheets.forEach((c, i) => {
    const { w, h } = c.frame.paper;
    if (i > 0) doc.addPage([w, h], 'landscape');
    const { items, layers } = flattenSheet(c);
    new ItemPainter(doc, layers, { pm: 1, X: p => p.x, Y: p => h - p.y }, fonts).draw(items);
  });
  return { bytes: doc.output('arraybuffer'), pages: sheets.length };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'sheet';

/** One DXF per sheet (paper mm): `[file name, content]`. */
export function buildSheetDxfFiles(project: ProjectData, modelName: string, opts: SheetExportOptions = {}): [string, string][] {
  return composeSheets(project, opts).map(c => {
    const { items, layers } = flattenSheet(c);
    const name = `${safeName(modelName)}-${safeName(c.sheet.number)}${c.sheet.name ? `-${safeName(c.sheet.name)}` : ''}.dxf`;
    return [name, planToDxf({ unit: 'mm', pm: 1, items, layers })];
  });
}

export async function exportSheetSetPdf(project: ProjectData, modelName: string, opts: SheetExportOptions = {}): Promise<boolean> {
  const r = await buildSheetSetPdf(project, modelName, opts);
  if (!r) return false;
  triggerDownload(new Blob([r.bytes], { type: 'application/pdf' }), `${safeName(modelName)}-sheets.pdf`);
  return true;
}

export async function exportSheetSetDxf(project: ProjectData, modelName: string, opts: SheetExportOptions = {}): Promise<boolean> {
  const files = buildSheetDxfFiles(project, modelName, opts);
  if (!files.length) return false;
  if (files.length === 1) {
    triggerDownload(new Blob([files[0][1]], { type: 'application/dxf' }), files[0][0]);
    return true;
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const [name, content] of files) zip.file(name, content);
  triggerDownload(await zip.generateAsync({ type: 'blob' }), `${safeName(modelName)}-sheets-dxf.zip`);
  return true;
}
