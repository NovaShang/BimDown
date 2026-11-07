/** Saved section view (one `section` row of global/view.csv). Plan coordinates;
 *  the view looks to the LEFT of start→end (a line drawn west→east looks north). */
export interface SectionDef {
  id: string;
  name: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Far clip distance in front of the cut line; undefined = unlimited. */
  depth?: number;
}

export type ElevationDir = 'north' | 'south' | 'east' | 'west';

/** The view shown in the side pane next to the plan / 3D canvas. */
export type OpenView =
  | { kind: 'elevation'; dir: ElevationDir }
  | { kind: 'section'; id: string };

/** Axis-aligned 3D section box in model coordinates (x/y plan, z absolute elevation). */
export interface SectionBoxBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export type AboveCutStyle = 'dashed' | 'hidden';

export interface ViewsState {
  open: OpenView | null;
  paneMaximized: boolean;
  /** 3D section box; `bounds` null until first enabled (then fitted to the model). */
  sectionBox: { enabled: boolean; bounds: SectionBoxBounds | null };
  /** Plan cut plane height above each level, in project units. Missing = default. */
  planCut: Record<string, number>;
  aboveCut: AboveCutStyle;
  /** Reflected ceiling plan: show what is cut and above the cut, hide what lies below it. */
  rcp: boolean;
  /** Bumped by user edits of the saved sections; EditorShell writes view.csv on change. */
  sectionsSaveSeq: number;
  /** Plan view scale (denominator): annotation text / tags / dimensions are drawn at it. */
  planScale: number;
  /** Bumped by user edits; EditorShell writes the files on change. */
  sheetsSaveSeq: number;
  viewAnnotationsSaveSeq: number;
  metadataSaveSeq: number;
}

export const PLAN_SCALES = [20, 50, 100, 200, 500] as const;
const PLAN_SCALE_KEY = 'bimdown:planScale';

function storedPlanScale(): number {
  if (typeof window === 'undefined') return 100;
  try {
    const v = parseInt(window.localStorage.getItem(PLAN_SCALE_KEY) ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 100;
  } catch { return 100; }
}

/** Remember the plan scale across sessions (UI preference, not project data). */
export function storePlanScale(scale: number): void {
  try { window.localStorage.setItem(PLAN_SCALE_KEY, String(scale)); } catch { /* private mode */ }
}

export const DEFAULT_CUT_HEIGHT = 1.2;

export const initialViewsState: ViewsState = {
  open: null,
  paneMaximized: false,
  sectionBox: { enabled: false, bounds: null },
  planCut: {},
  aboveCut: 'dashed',
  rcp: false,
  sectionsSaveSeq: 0,
  planScale: storedPlanScale(),
  sheetsSaveSeq: 0,
  viewAnnotationsSaveSeq: 0,
  metadataSaveSeq: 0,
};

export type ViewsAction =
  | { type: 'OPEN_VIEW'; view: OpenView | null }
  | { type: 'TOGGLE_VIEW_PANE_MAX' }
  | { type: 'SET_SECTION_BOX'; enabled?: boolean; bounds?: SectionBoxBounds | null }
  | { type: 'SET_PLAN_CUT'; levelId: string; height: number }
  | { type: 'SET_ABOVE_CUT_STYLE'; style: AboveCutStyle }
  | { type: 'TOGGLE_RCP' }
  /** `persist`: a user edit to write back to global/view.csv (not a file reload). */
  | { type: 'UPDATE_SECTIONS'; sections: SectionDef[]; persist?: boolean }
  | { type: 'SET_PLAN_SCALE'; scale: number }
  | { type: 'UPDATE_SHEETS'; sheets: import('../sheets/sheetTypes.ts').SheetSet; persist?: boolean }
  | { type: 'UPDATE_VIEW_ANNOTATIONS'; layers: import('../types.ts').LayerData[]; persist?: boolean }
  /** Title-block fields of project_metadata.json. */
  | { type: 'UPDATE_METADATA'; fields: Partial<Record<'project_name' | 'project_number' | 'client' | 'address', string>>; persist?: boolean };
