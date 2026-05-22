/**
 * Universal draw tool — dispatches to the element module's archetype.place
 * handler. The toolbar can target ANY registered element type with the same
 * activeTool='draw' string; the element's declared archetype determines what
 * actually happens.
 *
 * If the active drawingTarget has no element module (rare during V1/V2
 * transition), the tool no-ops; the legacy draw_line / draw_point / etc.
 * registry entries remain available as named fallbacks.
 */
import type { ToolHandler, ToolContext } from './types.ts';
import { getElementTool } from './archetypes/index.ts';

function delegate(ctx: ToolContext): ToolHandler | null {
  const state = ctx.getState();
  const target = state.drawingTarget;
  if (!target) return null;
  return getElementTool(target.tableName, 'place');
}

export const drawTool: ToolHandler = {
  cursor: 'crosshair',
  onPointerDown(ctx, e) {
    const inner = delegate(ctx);
    inner?.onPointerDown?.(ctx, e);
  },
  onPointerMove(ctx, e) {
    const inner = delegate(ctx);
    inner?.onPointerMove?.(ctx, e);
  },
  onPointerUp(ctx, e) {
    const inner = delegate(ctx);
    inner?.onPointerUp?.(ctx, e);
  },
};
