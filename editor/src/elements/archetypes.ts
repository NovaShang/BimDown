import type { ReactNode } from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import type { DrawingField, LayerStyle, GeometryType, PlacementType } from '../model/tableRegistry.ts';
import type { PropertyField } from '../model/propertyFields.ts';
import type { Level } from '../types.ts';

// ─── Archetype ───────────────────────────────────────────────────────────────

/**
 * Editing-interaction archetypes. An archetype determines placement/move/edit
 * behavior in the tools layer; element modules attach to one archetype and
 * supply parameters (defaults, validations, hosts).
 */
export type Archetype =
  | 'line'          // 2D line (e.g. wall)
  | 'spatial-line'  // 3D line with start/end Z (e.g. brace, beam)
  | 'topo-line'     // 3D line with connectors at endpoints (e.g. duct, pipe)
  | 'point'         // 1 location + optional rotation (e.g. column)
  | 'hosted'        // mounted on a host curve or surface (e.g. door, window, opening)
  | 'surface';      // closed polygon (e.g. slab, space, roof outline)

// ─── Geometry context ────────────────────────────────────────────────────────

/**
 * Read-only environment for `geometry(el, ctx)`. Provides access to neighbors,
 * level info, and the full element map so per-element geometry can resolve
 * cross-element interactions (miter, trim, hosted attach).
 *
 * Pure: geometry functions must not mutate ctx.
 */
export interface GeometryContext {
  level: Level;
  levelElevation: number;
  levelElevations: Map<string, number>;

  /** Full element map for the current scope (level-scoped + global). */
  allElements: Map<string, CanonicalElement>;

  /** Lookup by id (handles prefixed and unprefixed ids). */
  elementById(id: string): CanonicalElement | undefined;

  /** Elements of a specific table (excluding self if `selfId` given). */
  elementsByTable(tableName: string, selfId?: string): CanonicalElement[];

  /** Elements hosted on a given host element (e.g. doors/windows on a wall). */
  hostedOf(hostId: string): CanonicalElement[];

  /**
   * Compute-once-per-pass cache. The adapter constructs a fresh context per
   * render pass, so memoized values live only for the duration of that pass.
   * Use for cross-element solvers (e.g. miter for all walls on a level).
   */
  memo<T>(key: string, factory: () => T): T;
}

// ─── Draw contexts ───────────────────────────────────────────────────────────

export interface DrawContextBase {
  elementId: string;
  selected: boolean;
  hovered: boolean;
  /** Optional level elevation (for elements that need it at draw time). */
  levelElevation?: number;
}

/** Context passed to draw2D — SVG world is Y-down via outer scale(1,-1). */
export interface Draw2DContext extends DrawContextBase {
  /** Current canvas scale (model→screen). Used for paper-space line widths. */
  scale: number;
}

/** Context passed to draw3D — Three.js / R3F. */
export interface Draw3DContext extends DrawContextBase {
  /** Optional cap so element can decide LOD. */
  cameraDistance?: number;
}

// ─── Hit zones / bounds ──────────────────────────────────────────────────────

export interface HitZone {
  kind: 'polygon' | 'segment' | 'point';
  /** XY in model units. */
  points: { x: number; y: number }[];
  /** For 'segment' / 'point': pick radius in model units. */
  radius?: number;
  /** Sub-part tag (e.g. 'start-handle', 'end-handle', 'body'). */
  part?: string;
}

export interface Bounds {
  x: number; y: number; w: number; h: number;
}

// ─── ElementModule contract ──────────────────────────────────────────────────

/**
 * Self-contained definition of one element type (one CSV table).
 * Owns schema, archetype, geometry function, and per-platform draw functions.
 *
 * Generic `TFacts` is the element's own "shared facts" shape — the output of
 * `geometry()` and input to `draw2D` / `draw3D`. Each element defines its own
 * Facts type; there is no global IR.
 */
export interface ElementModule<TFacts = unknown> {
  // ─── Identity ──────────────────────────────────────────────────────────────
  table: string;
  discipline: string;
  archetype: Archetype;
  prefix: string;

  /**
   * Storage geometry type. If omitted, derived from archetype:
   *   line → 'line', spatial-line/topo-line → 'spatial_line', point → 'point',
   *   hosted → 'line', surface → 'polygon'.
   * Set explicitly for elements that don't follow the default (e.g. foundation: 'mixed').
   */
  geometryType?: GeometryType;

  /**
   * Placement type override. If omitted, derived from archetype:
   *   line → 'free_line', spatial-line/topo-line → 'spatial_line',
   *   point → 'free_point', hosted → 'hosted', surface → 'free_polygon'.
   * Grid uses 'grid' explicitly.
   */
  placementType?: PlacementType;

  // ─── Schema (CSV) ──────────────────────────────────────────────────────────
  csvHeaders: string[];
  defaults: Record<string, string>;

  /** No GeoJSON for this table (e.g. door/window/space/mesh). */
  csvOnly?: boolean;
  /** Both GeoJSON and CSV-only rows allowed (e.g. opening). */
  dualMode?: boolean;
  /** Element spans across levels via top_level_id. */
  hasVerticalSpan?: boolean;

  // ─── Host relationship (for archetype='hosted') ───────────────────────────
  hostType?: string;
  hostTables?: string[];
  widthAttr?: string;

  // ─── UI metadata ──────────────────────────────────────────────────────────
  drawingFields: DrawingField[];
  propertyFields: PropertyField[];
  layerStyle: LayerStyle;
  renderZIndex: number;

  // ─── Geometry + render ────────────────────────────────────────────────────

  /**
   * Pure: compute shared facts from the element + ctx. Returns null if the
   * element should not render (e.g. broken host reference, zero-length).
   */
  geometry(el: CanonicalElement, ctx: GeometryContext): TFacts | null;

  draw2D(facts: TFacts, ctx: Draw2DContext): ReactNode;
  draw3D(facts: TFacts, ctx: Draw3DContext): ReactNode;

  /** Optional: hit zones for selection (2D); falls back to draw2D's data-id. */
  hitZones?(facts: TFacts): HitZone[];

  /** Optional: model-space bounds (used for viewBox, marquee, etc.). */
  bbox?(facts: TFacts): Bounds | null;
}

/** Type-erased module for the registry. */
export type AnyElementModule = ElementModule<unknown>;
