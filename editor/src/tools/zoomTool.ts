import type { ToolHandler, ToolContext } from './types.ts';

export const zoomTool: ToolHandler = {
  cursor: 'zoom-in',

  onPointerDown(ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const rect = ctx.containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const delta = e.altKey ? 0.7 : 1.4;
    ctx.dispatch({
      type: 'ZOOM_BY',
      delta,
      centerX: e.clientX - rect.left,
      centerY: e.clientY - rect.top,
    });
  },
};
