import type { Tool } from '../state/editorTypes.ts';
import type { ToolHandler } from './types.ts';
import { selectTool } from './selectTool.ts';
import { panTool } from './panTool.ts';
import { zoomTool } from './zoomTool.ts';
import { drawLineTool } from './drawLineTool.ts';
import { drawPointTool } from './drawPointTool.ts';
import { drawPolygonTool } from './drawPolygonTool.ts';
import { drawGridTool } from './drawGridTool.ts';
import { drawHostedTool } from './drawHostedTool.ts';
import { relocateTool } from './relocateTool.ts';
import { relocateHostedTool } from './relocateHostedTool.ts';
import { rotateTool, mirrorTool, arrayTool, alignTool, offsetTool, pasteTool } from './modifyTools.ts';
import { drawTool } from './drawTool.ts';
import { trimCornerTool, trimSingleTool, splitTool } from './wallModifyTools.ts';
import { drawRegionTool } from './drawRegionTool.ts';
import { drawPickTool } from './drawPickTool.ts';
import { drawDimensionTool, drawTextTool, drawTagTool } from './annotationTools.ts';
import { drawSectionTool } from './drawSectionTool.ts';
import { underlayTool } from './underlayTool.ts';
import { matchTypeTool } from './matchTypeTool.ts';
import { slopeArrowTool } from './slopeArrowTool.ts';

const toolRegistry: Record<string, ToolHandler> = {
  // Universal selection / view / camera
  select: selectTool,
  orbit: selectTool,
  pan: panTool,
  zoom: zoomTool,

  // Universal placement — dispatches via element module's archetype
  draw: drawTool,

  // Universal move/edit — dispatches via element module's archetype
  // (relocate stays available as the named "move" operation)
  relocate: relocateTool,
  relocate_hosted: relocateHostedTool,
  rotate: rotateTool,
  mirror: mirrorTool,
  array: arrayTool,
  align: alignTool,
  offset: offsetTool,
  paste: pasteTool,

  // Wall modify tools (trim / extend / split)
  trim_corner: trimCornerTool,
  trim_single: trimSingleTool,
  split: splitTool,

  // Legacy archetype-keyed drawing tools (still callable by name; the new
  // archetype × operation lookup is at tools/archetypes/index.ts).
  draw_line: drawLineTool,
  draw_point: drawPointTool,
  draw_polygon: drawPolygonTool,
  draw_grid: drawGridTool,
  draw_hosted: drawHostedTool,
  // Grid-driven batch layout (columns at grids, beams between columns, beam system)
  draw_region: drawRegionTool,
  // Floor / roof / ceiling boundary picked from walls or a room
  draw_pick: drawPickTool,

  // Annotation (dimension / text / tag)
  draw_dimension: drawDimensionTool,
  draw_text: drawTextTool,
  draw_tag: drawTagTool,

  // View annotation: section line in the plan
  draw_section: drawSectionTool,

  // Point picking for underlay calibrate / move / rotate (underlay/store.ts)
  underlay: underlayTool,

  // Slope arrow of a sloped floor (tail, head), started from the slab panel
  draw_slope_arrow: slopeArrowTool,

  // Match type properties: source, then targets until Esc (MA)
  match_type: matchTypeTool,
};

export function getToolHandler(tool: Tool): ToolHandler {
  return toolRegistry[tool] || selectTool;
}

// Re-export the archetype × operation lookup so callers needing
// "tool for this element type, this operation" don't have to know the
// legacy tool name.
export { getElementTool, getArchetypeTool } from './archetypes/index.ts';
export type { ArchetypeOperation } from './archetypes/index.ts';
