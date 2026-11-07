import { describe, it, expect } from 'vitest';
import { marqueeHits } from './selectTool.ts';

describe('marquee: window vs crossing', () => {
  const rect = { x: 100, y: 100, w: 200, h: 100 };
  const inside = [{ x: 120, y: 120 }, { x: 180, y: 150 }];
  const across = [{ x: 50, y: 150 }, { x: 150, y: 150 }];
  const outside = [{ x: 10, y: 10 }, { x: 20, y: 20 }];
  it('left → right (window) takes only what is entirely inside', () => {
    expect(marqueeHits(true, inside, rect)).toBe(true);
    expect(marqueeHits(true, across, rect)).toBe(false);
    expect(marqueeHits(true, outside, rect)).toBe(false);
  });
  it('right → left (crossing) takes whatever the box touches', () => {
    expect(marqueeHits(false, inside, rect)).toBe(true);
    expect(marqueeHits(false, across, rect)).toBe(true);
    expect(marqueeHits(false, outside, rect)).toBe(false);
  });
});
