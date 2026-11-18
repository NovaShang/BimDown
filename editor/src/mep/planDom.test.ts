import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Device2D, type DeviceFacts } from './DeviceView.tsx';
import { setMepView } from './mepView.ts';

// Plan DOM size: an imported model has thousands of MEP elements, so the
// common case (no tag, no highlight, no isolate) draws without extra groups.
const nodes = (html: string) => (html.match(/<[a-z]/g) ?? []).length;

const terminal = (type: string): DeviceFacts => ({
  id: 'tm-1', table: 'terminal', position: { x: 1, y: 2 }, width: 0.6, depth: 0.6, height: 0.3,
  rotationDeg: 0, baseY: 0, material: '', color: '#f77f00', type, number: '', systemType: '',
  systemColor: '', flow: 0, load: 0, circuit: '',
});

describe('MEP plan DOM', () => {
  afterEach(() => setMepView({ isolate: null, highlight: null }));

  it('draws a grille as one group, its filled footprint, one path for its strokes', () => {
    const html = renderToStaticMarkup(createElement(Device2D, { facts: terminal('exhaust_air_grille'), selected: false }));
    expect(nodes(html)).toBe(3);
    expect(html).toContain('data-id="tm-1"');
    expect(html).not.toContain('transparent');
  });

  it('keeps the hit area for symbols that do not fill their footprint', () => {
    const html = renderToStaticMarkup(createElement(Device2D, { facts: terminal('sprinkler_head'), selected: false }));
    expect(html).toContain('fill="transparent"');
  });

  it('wraps in an outer group when isolated or tagged', () => {
    setMepView({ isolate: 'SA' });
    const html = renderToStaticMarkup(createElement(Device2D, { facts: terminal('return_air_grille'), selected: false }));
    expect(html).toMatch(/^<g data-id="tm-1" opacity="0.12">/);
    setMepView({ isolate: null });
    const tagged = renderToStaticMarkup(createElement(Device2D, { facts: { ...terminal('supply_air_diffuser'), flow: 120 }, selected: false }));
    expect(tagged).toContain('120 L/s');
    expect(tagged).toMatch(/^<g data-id="tm-1" opacity="1">/);
  });
});
