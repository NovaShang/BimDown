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
import type { CanonicalElement } from '../model/elements.ts';
import { renderWallFill } from './wallRenderer.tsx';
import { renderColumn } from './columnRenderer.tsx';
import { renderDoor } from './doorRenderer.tsx';
import { renderSpace } from './spaceRenderer.tsx';
import { renderSlab } from './slabRenderer.tsx';
import { renderEquipment } from './equipmentRenderer.tsx';

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
  // Line elements with special rendering
  door: renderDoor,
  // Polygon elements
  space: renderSpace,
  slab: renderSlab,
  structure_slab: renderSlab,
  stair: renderSlab,
};

export function getRenderer(tableName: string): ElementRenderFn | null {
  return RENDERERS[tableName] ?? null;
}
