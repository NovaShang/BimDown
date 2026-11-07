/**
 * Drawing sheets (spec csv-schema/sheet/): a title block on one paper size with
 * views placed on it. `global/sheet.csv` holds the sheets, `global/sheet_viewport.csv`
 * the views; viewport x / y are paper millimetres from the sheet's bottom-left.
 */
import type { DrawingDiscipline } from '../export/drawing/types.ts';

export type SheetPaper = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

/** ISO 216 landscape, mm. */
export const SHEET_PAPERS: Record<SheetPaper, { w: number; h: number }> = {
  A0: { w: 1189, h: 841 },
  A1: { w: 841, h: 594 },
  A2: { w: 594, h: 420 },
  A3: { w: 420, h: 297 },
  A4: { w: 297, h: 210 },
};

export interface SheetDef {
  id: string;
  number: string;
  name: string;
  paper: SheetPaper;
  revision: string;
  revisionDate: string;
  revisionNote: string;
  /** Empty = the export date. */
  issueDate: string;
  drawnBy: string;
  checkedBy: string;
}

export type ViewportType = 'plan' | 'section' | 'elevation' | 'schedule' | 'legend';

export const SCHEDULE_KEYS = ['rooms', 'doors', 'windows', 'walls', 'slabs', 'columns', 'framing', 'mep', 'equipment'] as const;

export interface ViewportDef {
  id: string;
  sheetId: string;
  type: ViewportType;
  /** Plan viewports. */
  levelId: string;
  /** Section id or elevation direction. */
  viewId: string;
  /** Schedule viewports: a SCHEDULES key. */
  schedule: string;
  discipline: DrawingDiscipline;
  /** Scale denominator. */
  scale: number;
  /** Centre on the paper, mm from the bottom-left. */
  x: number;
  y: number;
  /** Empty = the view's own name. */
  title: string;
}

export interface SheetSet {
  sheets: SheetDef[];
  viewports: ViewportDef[];
}

export const DEFAULT_PAPER: SheetPaper = 'A1';
