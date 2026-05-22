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
import { rotateTool } from './rotateTool.ts';
import { drawTool } from './drawTool.ts';

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

  // Legacy archetype-keyed drawing tools (still callable by name; the new
  // archetype × operation lookup is at tools/archetypes/index.ts).
  draw_line: drawLineTool,
  draw_point: drawPointTool,
  draw_polygon: drawPolygonTool,
  draw_grid: drawGridTool,
  draw_hosted: drawHostedTool,
};

export function getToolHandler(tool: Tool): ToolHandler {
  return toolRegistry[tool] || selectTool;
}

// Re-export the archetype × operation lookup so callers needing
// "tool for this element type, this operation" don't have to know the
// legacy tool name.
export { getElementTool, getArchetypeTool } from './archetypes/index.ts';
export type { ArchetypeOperation } from './archetypes/index.ts';
