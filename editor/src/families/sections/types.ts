/**
 * Section family — a parametric cross-section description.
 *
 * Each family declares its own parameter schema (an I-beam's params are
 * different from a rectangular column's). Given a concrete param object the
 * family generates: the 2D plan-view outline, the 3D extrusion shape, and a
 * plan-view bounding box.
 *
 * Section families are the first concrete instance of the BimDown "family"
 * concept described in FAMILY_VISION.md — keep them small and self-contained.
 */
import type { Shape } from 'three';
import type { Point } from '../../model/elements.ts';
import type { Shape2D } from '../../three/primitives/types.ts';

/** Parameter declaration — used both to validate inputs and to auto-build
 *  property-panel rows when the user picks a section. */
export interface SectionParamDef {
  key: string;
  label: string;
  default: number;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
}

/** Numeric parameter values for one instance of a section. */
export type SectionParams = Record<string, number>;

export interface SectionFamily {
  id: string;
  label: string;
  /** Parameters in the order they should appear in the UI. */
  params: SectionParamDef[];
  /**
   * Resolve raw string attrs into validated numeric params. Missing or
   * non-finite values fall back to the per-param default; legacy elements
   * may pass `size_x` / `size_y` and the family decides how to map them.
   */
  resolveParams(attrs: Record<string, string>): SectionParams;
  /** 2D plan outline (centered at origin). Used by column.draw2D / beam.draw2D
   *  to show the actual cross-section instead of a generic rect. */
  outline2D(p: SectionParams): Point[];
  /** 3D extrusion shape (Shape2D for createProfile compatibility). */
  shape3D(p: SectionParams): Shape2D;
  /** Plan-view bounding extent (full width / depth, not half). */
  bbox(p: SectionParams): { w: number; d: number };
}

/** Adapter so existing call sites that expect a THREE.Shape can keep working. */
export type SectionShape3DBuilder = (p: SectionParams) => Shape;
