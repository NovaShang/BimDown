/**
 * Element renderer registry.
 *
 * Each renderer takes a CanonicalElement and returns SVG elements
 * directly — no serialize→parse→process round-trip.
 * Coordinates are in model space (Y-up); the parent applies scale(1,-1).
 *
 * To add a new element type:
 * 1. Create a renderer function in this directory
 * 2. Register it in RENDERERS below
 */
import type { CanonicalElement, PolygonElement } from '../model/elements.ts';
import { renderWallFill } from './wallRenderer.tsx';
import { renderColumn } from './columnRenderer.tsx';
import { renderDoor } from './doorRenderer.tsx';
import { renderWindow } from './windowRenderer.tsx';
import { renderSpace } from './spaceRenderer.tsx';
import { renderSlab } from './slabRenderer.tsx';
import { renderEquipment } from './equipmentRenderer.tsx';
import { renderGrid } from './gridRenderer.tsx';

export type ElementRenderFn = (el: CanonicalElement) => React.JSX.Element | null;

const RENDERERS: Record<string, ElementRenderFn> = {
  // Walls & MEP lines — fill only, outlines handled by WallOutlines
  wall: renderWallFill,
  curtain_wall: renderWallFill,
  structure_wall: renderWallFill,
  duct: renderWallFill,
  pipe: renderWallFill,
  conduit: renderWallFill,
  cable_tray: renderWallFill,
  // Point elements
  column: renderColumn,
  structure_column: renderColumn,
  equipment: renderEquipment,
  terminal: renderEquipment,
  mep_node: renderEquipment,
  // Line elements with special rendering
  door: renderDoor,
  window: renderWindow,
  // Polygon elements
  space: renderSpace,
  slab: renderSlab,
  structure_slab: renderSlab,
  stair: renderSlab,
  roof: renderSlab,
  ceiling: renderSlab,
  // Line / spatial_line elements
  beam: renderWallFill,
  brace: renderWallFill,
  ramp: renderWallFill,
  railing: renderWallFill,
  room_separator: renderWallFill,
  // Openings (dual-mode: wall openings are invisible, slab openings show outline)
  opening: renderOpening,
  // Reference elements
  grid: renderGrid,
};

/** Opening renderer: wall openings have no 2D representation (implicit in wall cutout),
 *  slab openings render as dashed polygon outlines. */
function renderOpening(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry === 'polygon') {
    const { vertices, id } = el as PolygonElement;
    if (vertices.length < 3) return null;
    const pts = vertices.map(v => `${v.x},${v.y}`).join(' ');
    return (
      <polygon
        key={id}
        points={pts}
        fill="rgba(255,138,101,0.06)"
        stroke="#ff8a65"
        strokeWidth={0.02}
        strokeDasharray="0.05 0.03"
        data-id={id}
      />
    );
  }
  // Wall openings (line geometry) — no 2D rendering, handled by wall cutout
  return null;
}

/** Mixed-geometry renderer: dispatches based on element's actual geometry type. */
function renderFoundation(el: CanonicalElement): React.JSX.Element | null {
  switch (el.geometry) {
    case 'point': return renderEquipment(el);   // isolated foundation
    case 'line': return renderWallFill(el);      // strip foundation
    case 'polygon': return renderSlab(el);       // raft foundation
    default: return null;
  }
}

export function getRenderer(tableName: string): ElementRenderFn | null {
  if (tableName === 'foundation') return renderFoundation;
  return RENDERERS[tableName] ?? null;
}
