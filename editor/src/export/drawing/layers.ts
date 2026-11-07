/**
 * Drawing layers for plan output, named after the US National CAD Standard /
 * AIA layer guidelines (discipline-major-minor) so a CAD user finds them where
 * they expect. Each layer carries its pen: colour (PDF ink + DXF ACI),
 * lineweight in paper millimetres and linetype.
 */
import { nearestAci } from './color.ts';

export type LineDash = 'solid' | 'dashed' | 'hidden' | 'center';

export interface DrawingLayer {
  name: string;
  /** Ink colour for PDF; DXF uses `aci` (and `trueColor` when set). */
  color: string;
  /** AutoCAD colour index. */
  aci: number;
  /** Line weight in paper mm. */
  weight: number;
  dash: LineDash;
  /** Set for layers whose colour isn't an ACI (e.g. MEP system colours). */
  trueColor?: boolean;
  description: string;
}

const L = (name: string, color: string, aci: number, weight: number, dash: LineDash, description: string): DrawingLayer =>
  ({ name, color, aci, weight, dash, description });

export const LAYERS = {
  grid:        L('S-GRID',      '#555555', 8, 0.13, 'center', 'Grid lines'),
  gridIden:    L('S-GRID-IDEN', '#222222', 7, 0.25, 'solid',  'Grid bubbles and labels'),
  slab:        L('A-FLOR-OTLN', '#7a7a7a', 8, 0.13, 'solid',  'Floor and slab edges'),
  roof:        L('A-ROOF-OTLN', '#555555', 8, 0.18, 'solid',  'Roof outline'),
  floorOpen:   L('A-FLOR-OPEN', '#444444', 7, 0.18, 'solid',  'Slab and roof openings'),
  stair:       L('A-FLOR-STRS', '#333333', 7, 0.18, 'solid',  'Stairs, landings and ramps'),
  stairAbove:  L('A-FLOR-STRS-ABOV', '#333333', 7, 0.13, 'hidden', 'Stair treads above the cut plane'),
  railing:     L('A-FLOR-HRAL', '#444444', 7, 0.25, 'solid',  'Railings'),
  area:        L('A-AREA',      '#3a86ff', 5, 0.09, 'solid',  'Room boundaries (CAD only)'),
  areaBndy:    L('A-AREA-BNDY', '#9a9a9a', 9, 0.09, 'solid',  'Room separation lines'),
  areaIden:    L('A-AREA-IDEN', '#1a1a1a', 7, 0.18, 'solid',  'Room names, numbers and areas'),
  wall:        L('A-WALL',      '#111111', 7, 0.5,  'solid',  'Walls (cut)'),
  wallPatt:    L('A-WALL-PATT', '#8c8c8c', 8, 0.05, 'solid',  'Wall poché fill'),
  wallAbove:   L('A-WALL-HEAD', '#555555', 8, 0.13, 'hidden', 'Wall above openings'),
  curtainWall: L('A-GLAZ-CWMG', '#222222', 7, 0.25, 'solid',  'Curtain walls'),
  column:      L('A-COLS',      '#111111', 7, 0.35, 'solid',  'Architectural columns'),
  columnPatt:  L('A-COLS-PATT', '#5c5c5c', 8, 0.05, 'solid',  'Column poché fill'),
  door:        L('A-DOOR',      '#111111', 7, 0.25, 'solid',  'Doors'),
  doorSwing:   L('A-DOOR-SWNG', '#444444', 7, 0.13, 'solid',  'Door swings'),
  window:      L('A-GLAZ',      '#111111', 7, 0.18, 'solid',  'Windows'),
  sWall:       L('S-WALL',      '#000000', 7, 0.5,  'solid',  'Structural walls (cut)'),
  sWallPatt:   L('S-WALL-PATT', '#3a3a3a', 8, 0.05, 'solid',  'Structural wall poché fill'),
  sColumn:     L('S-COLS',      '#000000', 7, 0.35, 'solid',  'Structural columns'),
  sColumnPatt: L('S-COLS-PATT', '#262626', 7, 0.05, 'solid',  'Structural column poché fill'),
  sBeam:       L('S-BEAM',      '#333333', 7, 0.25, 'hidden', 'Beams (above)'),
  sBrace:      L('S-BRCG',      '#333333', 7, 0.25, 'hidden', 'Braces'),
  sSlab:       L('S-SLAB',      '#7a7a7a', 8, 0.13, 'solid',  'Structural slab edges'),
  sFoundation: L('S-FNDN',      '#444444', 7, 0.25, 'hidden', 'Foundations (below)'),
  mEquip:      L('M-EQPM',      '#1a1a1a', 7, 0.35, 'solid',  'Mechanical equipment'),
  mEquipIden:  L('M-EQPM-IDEN', '#1a1a1a', 7, 0.18, 'solid',  'Equipment tags'),
  mTerminal:   L('M-HVAC-TERM', '#1a1a1a', 7, 0.25, 'solid',  'Air terminals and fixtures'),
  mFitting:    L('M-FITT',      '#333333', 7, 0.18, 'solid',  'MEP fittings and accessories'),
  annoText:    L('G-ANNO-TEXT', '#1a1a1a', 7, 0.18, 'solid',  'General annotation text'),
  annoDims:    L('G-ANNO-DIMS', '#1a1a1a', 7, 0.13, 'solid',  'Dimensions'),
} satisfies Record<string, DrawingLayer>;

export type LayerKey = keyof typeof LAYERS;

/** Layer name prefix per MEP table; the system code is appended (M-DUCT-SA). */
const MEP_LAYER_PREFIX: Record<string, string> = {
  duct: 'M-DUCT', pipe: 'P-PIPE', cable_tray: 'E-CABL-TRAY', conduit: 'E-COND',
};

/** Per-table, per-system MEP layer coloured with the system colour. */
export function mepLayer(table: string, systemType: string, color: string): DrawingLayer {
  const prefix = MEP_LAYER_PREFIX[table] ?? 'M-MISC';
  const sys = systemType.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_');
  const weight = table === 'pipe' || table === 'conduit' ? 0.35 : 0.25;
  return {
    name: sys ? `${prefix}-${sys}` : prefix,
    color, aci: nearestAci(color), weight, dash: 'solid', trueColor: true,
    description: sys ? `${table} ${sys}` : table,
  };
}
