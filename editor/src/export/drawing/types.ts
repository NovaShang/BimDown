import type { Point } from '../../model/elements.ts';
import type { ProjectUnit } from '../../types.ts';
import type { DrawingLayer, LineDash } from './layers.ts';

/** Which part of the model a sheet shows; the others are dropped or half-toned. */
export type DrawingDiscipline = 'architecture' | 'structure' | 'mep' | 'all';

interface ItemBase {
  /** Layer name (a key of `PlanDrawing.layers`). */
  layer: string;
  /** Overrides the layer ink. */
  color?: string;
  /** Overrides the layer line weight (paper mm). */
  weight?: number;
  /** Overrides the layer linetype. */
  dash?: LineDash;
  /** Context drawn faded in PDF (DXF keeps full colour; layers separate it there). */
  halftone?: boolean;
  /** Only written to DXF (e.g. room boundaries a CAD user may want to pick). */
  dxfOnly?: boolean;
}

/** All coordinates are model coordinates (project units, Y up). */
export type DrawItem =
  | ItemBase & {
      kind: 'path';
      pts: Point[];
      closed: boolean;
      /** Solid fill (PDF fill / DXF SOLID hatch). */
      fill?: string;
      /** Fill only, no outline. */
      noStroke?: boolean;
    }
  | ItemBase & {
      kind: 'arc';
      center: Point;
      radius: number;
      /** Radians, counter-clockwise from `start` to `end`. */
      start: number;
      end: number;
    }
  | ItemBase & {
      kind: 'circle';
      center: Point;
      radius: number;
      fill?: string;
      noStroke?: boolean;
    }
  | ItemBase & {
      kind: 'text';
      at: Point;
      text: string;
      /** Cap height in model units. */
      height: number;
      align: 'left' | 'center' | 'right';
      valign: 'baseline' | 'middle';
      /** Radians, counter-clockwise. */
      rotation?: number;
      bold?: boolean;
    };

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export interface LegendEntry { label: string; color: string }

/** One level's plan, ready for a PDF page or a DXF file. */
export interface PlanDrawing {
  levelId: string;
  levelName: string;
  elevation: number;
  unit: ProjectUnit;
  /** Scale denominator (100 → 1:100). */
  scale: number;
  /** Model units per paper millimetre at this scale. */
  pm: number;
  items: DrawItem[];
  /** Layers used by `items`, in first-use order. */
  layers: Map<string, DrawingLayer>;
  /** Extent of everything drawn (model units), null when empty. */
  bounds: Box | null;
  /** MEP systems drawn, for the sheet legend. */
  legend: LegendEntry[];
}
