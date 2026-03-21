import type { ToolHandler, ToolContext } from './types.ts';

let isPanning = false;
let lastPos = { x: 0, y: 0 };

export const panTool: ToolHandler = {
  cursor: 'grab',

  onPointerDown(_ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    isPanning = true;
    lastPos = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (!isPanning) return;
    const dx = e.clientX - lastPos.x;
    const dy = e.clientY - lastPos.y;
    lastPos = { x: e.clientX, y: e.clientY };
    const { transform } = ctx.getState();
    ctx.dispatch({
      type: 'SET_TRANSFORM',
      transform: {
        ...transform,
        x: transform.x + dx,
        y: transform.y + dy,
      },
    });
  },

  onPointerUp() {
    isPanning = false;
  },
};
