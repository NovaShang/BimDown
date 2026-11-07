/**
 * Annotation hook for plan drawings. Annotators (dimensions, tags, tables…)
 * run after the model graphics of a level are built and add items with
 * ctx.add(); the PDF and DXF writers draw them like any other item, on the
 * annotation layers (`G-ANNO-DIMS`, `G-ANNO-TEXT`) or layers of their own.
 *
 *   registerPlanAnnotator(ctx => {
 *     const h = 2.5 * ctx.pm; // 2.5 mm text on paper
 *     ctx.add({ kind: 'text', layer: ctx.layer(LAYERS.annoDims), at, text: '3600', height: h, align: 'center', valign: 'baseline' });
 *   });
 */
import type { CanonicalElement } from '../../model/elements.ts';
import type { Level, ProjectUnit } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';
import type { DrawingLayer } from './layers.ts';
import type { DrawingDiscipline, DrawItem } from './types.ts';

export interface PlanAnnotationContext {
  level: Level;
  unit: ProjectUnit;
  /** Scale denominator (100 → 1:100). */
  scale: number;
  /** Model units per paper millimetre: a 2.5 mm text is `2.5 * pm` high. */
  pm: number;
  /** Model units per metre (1 for m, 1000 for mm, …). */
  upm: number;
  discipline: DrawingDiscipline;
  /** The level's elements (hosted geometry resolved), global ones and grids included. */
  elements: CanonicalElement[];
  geometry: GeometryContext;
  /** The element module's geometry facts (cached), or null. */
  factsOf(el: CanonicalElement): unknown;
  /** Register a layer for use and return its name. */
  layer(def: DrawingLayer): string;
  add(item: DrawItem): void;
}

export type PlanAnnotator = (ctx: PlanAnnotationContext) => void;

const annotators: PlanAnnotator[] = [];

/** Add an annotator to every plan export; returns a function that removes it. */
export function registerPlanAnnotator(fn: PlanAnnotator): () => void {
  annotators.push(fn);
  return () => {
    const i = annotators.indexOf(fn);
    if (i >= 0) annotators.splice(i, 1);
  };
}

export function registeredPlanAnnotators(): readonly PlanAnnotator[] {
  return annotators;
}
