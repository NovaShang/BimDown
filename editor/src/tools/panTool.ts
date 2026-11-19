import type { ToolHandler, ToolContext } from './types.ts';

const gesture = { active: false, lastX: 0, lastY: 0 };

export const panTool: ToolHandler = {
  cursor: 'grab',

  onPointerDown(_ctx: ToolContext, e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    gesture.active = true;
    gesture.lastX = e.clientX;
    gesture.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  },

  onPointerMove(ctx: ToolContext, e: React.PointerEvent) {
    if (!gesture.active) return;
    const dx = e.clientX - gesture.lastX;
    const dy = e.clientY - gesture.lastY;
    gesture.lastX = e.clientX;
    gesture.lastY = e.clientY;
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
    gesture.active = false;
  },
};
