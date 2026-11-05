import { describe, expect, it } from 'vitest';
import { placeTourBubble } from './tourPlacement.ts';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

describe('placeTourBubble', () => {
  const bubble = { w: 256, h: 128 };

  it('centers the bubble above / below the target when there is room', () => {
    expect(placeTourBubble(rect(600, 12, 240, 44), 'bottom', bubble, { w: 1440, h: 900 }, 8)).toEqual({ left: 592, top: 64 });
    expect(placeTourBubble(rect(346, 832, 748, 56), 'top', bubble, { w: 1440, h: 900 }, 8)).toEqual({ left: 592, top: 696 });
  });

  it('keeps the bubble inside the viewport for a target in the corner', () => {
    // The zoom bar at the bottom-left: a centered bubble would start at x = -53
    const p = placeTourBubble(rect(12, 846, 125, 42), 'top', bubble, { w: 1440, h: 900 }, 8);
    expect(p).toEqual({ left: 8, top: 846 - 8 - 128 });
  });

  it('fits a 390 px wide phone screen', () => {
    for (const target of [rect(12, 760, 366, 56), rect(300, 64, 80, 40), rect(0, 0, 390, 30)]) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const p = placeTourBubble(target, side, { w: 256, h: 154 }, { w: 390, h: 844 }, 8);
        expect(p.left).toBeGreaterThanOrEqual(8);
        expect(p.left + 256).toBeLessThanOrEqual(390 - 8);
        expect(p.top).toBeGreaterThanOrEqual(8);
        expect(p.top + 154).toBeLessThanOrEqual(844 - 8);
      }
    }
  });
});
