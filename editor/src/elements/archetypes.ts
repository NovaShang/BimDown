import type { ReactNode } from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import type { DrawingField, LayerStyle, GeometryType, PlacementType } from '../model/tableRegistry.ts';
import type { PropertyField } from './_propertyFields.ts';
import type { Level, SystemDef } from '../types.ts';

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

  /**
   * Project-level MEP system definitions from `global/mep_system.csv`.
   * Empty array when the file is absent. Consumers (today: MEP line geometry)
   * use this to override the editor's curated system color with a user-defined
   * one. Stored on the context so geometry passes don't have to reach into
   * editor state.
   */
  projectSystems(): SystemDef[];
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
  /** True when the element's host (resolved by host_id) is in the selection.
   *  Only populated for hosted elements (e.g. connector) — others may ignore. */
  hostSelected?: boolean;
  /** True when the active drawing tool targets an MEP curve table. Connectors
   *  use this to show all ports while the user is laying out pipes. */
  mepToolActive?: boolean;
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

// ─── Selection handles ───────────────────────────────────────────────────────

/**
 * A draggable handle a module exposes for the selection UI. Replaces the
 * built-in "line endpoints / point bbox / polygon vertices" defaults when an
 * element type has parameters that don't fit those shapes (e.g. a round
 * column's radius, a room's move-only seed at the label).
 */
export interface SelectionHandle {
  /** Stable id within the element. Used as React key + drag identification. */
  id: string;
  /** Visible position in model coords. */
  position: { x: number; y: number };
  /** CSS cursor when hovering. Defaults to `move`. */
  cursor?: string;
  /** Optional fill color override (default: cyan). */
  color?: string;
  /**
   * Called on each pointermove during a drag. Receives the snapped pointer
   * position in model coords, the pointer position at pointerdown (for
   * delta-based "translate" handles), and the element snapshot taken at
   * drag-start (stable origin to compute from — avoids drift from
   * mid-drag preview updates). Returns the partial element to merge via
   * RESIZE_ELEMENT { preview: true }.
   */
  onDrag(
    snapped: { x: number; y: number },
    dragStart: { x: number; y: number },
    snapshot: CanonicalElement,
  ): Partial<CanonicalElement>;
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

  /**
   * If true, this element type is internal and should NOT appear in the
   * placement toolbar. The element is still rendered when present in data,
   * and is still listed in the layer panel for visibility toggling. Used
   * for table types that users never create directly (e.g. mep_node —
   * fittings materialize from MEP-line topology).
   */
  hiddenFromToolbar?: boolean;

  /**
   * Optional: multiple toolbar entries for this module, each placing a
   * different geometry kind into the same CSV table. See `ToolbarVariant`.
   * When set, the toolbar renders N entries (one per variant) instead of
   * the single default entry derived from `archetype`/`placementType`.
   */
  toolbarVariants?: ToolbarVariant[];

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

  // ─── Selection UI ─────────────────────────────────────────────────────────

  /**
   * Anchor for the floating action bar / selection overlay. Pure function on
   * the canonical element so it can be called outside the geometry provider
   * (e.g. EditorShell-level useOverlayItems). Default: bbox center derived
   * from geometry. Override when the visual focus of an element diverges
   * from its geometric bbox center (e.g. a room's label position).
   */
  selectionAnchor?(element: CanonicalElement): { x: number; y: number };

  /**
   * Selection handles for this element. When omitted, ResizeHandles renders
   * the built-in geometry-based defaults (line endpoints + arc midpoint,
   * point bbox corners, polygon vertices). Return `undefined` to fall through
   * to the default; `[]` to render no handles. Override to express
   * element-specific edits (round column diameter, room move-on-label, etc.).
   */
  selectionHandles?(facts: TFacts, element: CanonicalElement): SelectionHandle[] | undefined;

  /**
   * Called when the placement tool for this table activates. Receives the
   * count of existing elements of this table in the loaded document; returned
   * attrs are merged on top of `getDefaultDrawingAttrs` so the toolbar shows
   * them pre-populated. Used for sequential defaults like "Room N".
   */
  autoFillOnPlace?(existingCount: number): Record<string, string>;

  /**
   * Whether instances of this element type should participate as targets in
   * cursor snap (endpoint / center / edge / midpoint). Default true. Set
   * `false` for abstract markers — grids, rooms, future annotations — whose
   * positions are conceptual labels rather than geometric features users
   * want to align other objects to.
   */
  isSnapTarget?: boolean;
}

/** Type-erased module for the registry. */
export type AnyElementModule = ElementModule<unknown>;

// ─── Toolbar variants ────────────────────────────────────────────────────────

/**
 * One toolbar entry for a module that declares multiple placement variants.
 * Example: foundation has three variants (isolated/point, strip/line, raft/polygon)
 * that all write to the same `foundation` table but use different geometries.
 *
 * When a module declares `toolbarVariants`, the FloatingToolbar shows N entries
 * (one per variant) instead of the module's default single entry. Picking a
 * variant carries its `id` forward through `state.drawingTarget.variantId`,
 * which the drawing tools use to:
 *   - pick the correct placement tool (via `placementType`)
 *   - merge variant-specific `defaults` into the new element's attrs.
 */
export interface ToolbarVariant {
  /** Unique within this module, e.g. 'isolated' / 'strip' / 'raft'. */
  id: string;
  /** Toolbar short label. Plain text or i18n key — resolved at render time. */
  label: string;
  /** Single-char icon shown in the toolbar (matches LayerStyle.icon style). */
  icon: string;
  /** Placement type for this variant — overrides module's default placement. */
  placementType: PlacementType;
  /** Default attrs merged on top of `module.defaults` when this variant is used. */
  defaults?: Record<string, string>;
}
