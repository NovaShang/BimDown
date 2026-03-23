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

const toolRegistry: Record<string, ToolHandler> = {
  select: selectTool,
  pan: panTool,
  zoom: zoomTool,
  draw_line: drawLineTool,
  draw_point: drawPointTool,
  draw_polygon: drawPolygonTool,
  draw_grid: drawGridTool,
  draw_hosted: drawHostedTool,
};

export function getToolHandler(tool: Tool): ToolHandler {
  return toolRegistry[tool] || selectTool;
}
