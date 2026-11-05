import { describe, expect, it } from 'vitest';
import { fitTransform, insetsFromRects, keepInPlace, shouldAutoFit, type Box, type Size } from './fitView.ts';
import type { ViewTransform } from '../state/editorTypes.ts';

/** Screen position (container px) of an SVG point: viewBox `meet` mapping, then the canvas transform. */
function toScreen(p: { x: number; y: number }, vb: Box, size: Size, t: ViewTransform) {
  const s = Math.min(size.w / vb.w, size.h / vb.h);
  const lx = (size.w - vb.w * s) / 2 + (p.x - vb.x) * s;
  const ly = (size.h - vb.h * s) / 2 + (p.y - vb.y) * s;
  return { x: t.x + t.scale * lx, y: t.y + t.scale * ly };
}

const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;

describe('fitTransform', () => {
  const size = { w: 1440, h: 900 };

  it('fits the content inside the area left free by the panels', () => {
    // A 40 x 15 m office far from the origin, in a viewBox that also holds stale/empty space
    const content: Box = { x: 100, y: -230, w: 40, h: 15 };
    const viewBox: Box = { x: -15, y: -240, w: 200, h: 60 };
    const insets = { top: 56, right: 372, bottom: 60, left: 220 };
    const t = fitTransform(content, viewBox, size, insets, 24);
    const a = toScreen({ x: content.x, y: content.y }, viewBox, size, t);
    const b = toScreen({ x: content.x + content.w, y: content.y + content.h }, viewBox, size, t);
    expect(a.x).toBeGreaterThanOrEqual(220 + 24 - 1e-6);
    expect(b.x).toBeLessThanOrEqual(1440 - 372 - 24 + 1e-6);
    expect(a.y).toBeGreaterThanOrEqual(56 + 24 - 1e-6);
    expect(b.y).toBeLessThanOrEqual(900 - 60 - 24 + 1e-6);
    // Wide content: fills the free width, centered in the free area
    expect(b.x - a.x).toBeCloseTo(1440 - 220 - 372 - 48);
    expect((a.x + b.x) / 2).toBeCloseTo(220 + (1440 - 220 - 372) / 2);
    expect((a.y + b.y) / 2).toBeCloseTo(56 + (900 - 56 - 60) / 2);
  });

  it('is the identity when the content is the viewBox and nothing covers the canvas', () => {
    const vb: Box = { x: 0, y: -10, w: 16, h: 10 };
    const t = fitTransform(vb, vb, { w: 1600, h: 1000 }, undefined, 0);
    expect(t.scale).toBeCloseTo(1);
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBeCloseTo(0);
  });

  it('ignores side panels that would leave too little room (narrow screens)', () => {
    const vb: Box = { x: 0, y: -10, w: 10, h: 10 };
    const t = fitTransform(vb, vb, { w: 400, h: 800 }, { top: 0, right: 200, bottom: 0, left: 150 }, 0);
    const a = toScreen({ x: 0, y: -10 }, vb, { w: 400, h: 800 }, t);
    expect(a.x).toBeCloseTo(0);
  });
});

describe('keepInPlace', () => {
  it('keeps every point on screen where it was when the viewBox grows', () => {
    const size = { w: 1200, h: 800 };
    const from: Box = { x: 0, y: -10, w: 12, h: 10 };
    const to: Box = { x: -5, y: -30, w: 40, h: 35 };
    const t: ViewTransform = { x: 37, y: -12, scale: 2.5 };
    const t2 = keepInPlace(t, from, to, size);
    for (const p of [{ x: 0, y: 0 }, { x: 3, y: -7 }, { x: 20, y: -25 }]) {
      const a = toScreen(p, from, size, t);
      const b = toScreen(p, to, size, t2);
      expect(b.x).toBeCloseTo(a.x);
      expect(b.y).toBeCloseTo(a.y);
    }
  });
});

describe('shouldAutoFit', () => {
  const idle = { userMoved: false, userEdited: false };
  it('fits when a level is first shown, even after the user moved', () => {
    expect(shouldAutoFit({ level: null, hadContent: false }, { level: 'lv-1', hasContent: true, ...idle })).toBe(true);
    expect(shouldAutoFit({ level: 'lv-1', hadContent: true }, { level: 'lv-2', hasContent: true, userMoved: true, userEdited: true })).toBe(true);
  });
  it('fits once when an empty level gets content from outside', () => {
    expect(shouldAutoFit({ level: 'lv-1', hadContent: false }, { level: 'lv-1', hasContent: true, ...idle })).toBe(true);
    expect(shouldAutoFit({ level: 'lv-1', hadContent: true }, { level: 'lv-1', hasContent: true, ...idle })).toBe(false);
  });
  it("doesn't fight the user", () => {
    expect(shouldAutoFit({ level: 'lv-1', hadContent: false }, { level: 'lv-1', hasContent: true, userMoved: true, userEdited: false })).toBe(false);
    // Drawing the first wall in an empty project
    expect(shouldAutoFit({ level: 'lv-1', hadContent: false }, { level: 'lv-1', hasContent: true, userMoved: false, userEdited: true })).toBe(false);
  });
});

describe('insetsFromRects', () => {
  it('measures how far each panel reaches into the canvas', () => {
    const container = rect(0, 0, 1440, 900);
    const insets = insetsFromRects(container, [
      { side: 'left', rect: rect(12, 64, 220, 848) },
      { side: 'right', rect: rect(1068, 64, 1428, 836) },
      { side: 'top', rect: rect(604, 12, 836, 54) },
      { side: 'bottom', rect: rect(346, 832, 1094, 888) },
      { side: 'bottom', rect: rect(12, 846, 137, 888) },
      { side: 'left', rect: rect(0, 0, 0, 0) }, // hidden
    ]);
    expect(insets).toEqual({ left: 220, right: 372, top: 54, bottom: 68 });
  });
});
