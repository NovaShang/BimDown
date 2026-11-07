import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { ANNOTATION_DISCIPLINE, DIMENSION_HEADERS, fmtCoord } from '../annotation/model.ts';
import {
  resolveDimension, formatDimension, readableAngle, metre, add, sub, mul, mid, dot, len,
} from '../annotation/geometry.ts';

export interface DimensionFacts {
  id: string;
  p1: Point; p2: Point;
  d1: Point; d2: Point;
  u: Point; n: Point;
  label: string;
  /** Text centre and reading angle (deg). */
  textAt: Point;
  angle: number;
  /** True when an end lost its reference target (drawn dashed). */
  broken: boolean;
}

export const DIM_INK = '#1d3557';
const SELECTED = '#3a7bff';

/** Witness line from a measured point to the dimension line, with a small gap and overshoot. */
function witness(p: Point, d: Point, m: number): [Point, Point] | null {
  const v = sub(d, p);
  const l = len(v);
  const gap = 0.08 * m;
  if (l < gap) return null;
  const dir = mul(v, 1 / l);
  return [add(p, mul(dir, gap)), add(d, mul(dir, 0.1 * m))];
}

export const dimensionModule: ElementModule<DimensionFacts> = {
  table: 'dimension',
  discipline: ANNOTATION_DISCIPLINE,
  archetype: 'line',
  prefix: 'dm',
  csvOnly: true,
  hiddenFromToolbar: true,
  isSnapTarget: false,
  supportsArc: false,
  csvHeaders: DIMENSION_HEADERS,
  defaults: { start_ref: '', end_ref: '', direction: '', offset: '0', text: '' },
  drawingFields: [
    {
      key: 'dim_mode', label: 'Mode', type: 'select', options: [
        { value: 'aligned', label: 'Aligned' },
        { value: 'linear', label: 'Linear' },
        { value: 'wall_run', label: 'Wall Run' },
      ],
    },
  ],
  propertyFields: [
    { key: 'text', label: 'Text Override', type: 'text', group: 'identity' },
    { key: 'offset', label: 'Offset', type: 'number', unit: 'm', step: 0.1, group: 'geometry' },
    { key: 'direction', label: 'Direction', type: 'number', unit: '°', step: 15, group: 'geometry' },
    { key: 'start_ref', label: 'Start Ref', type: 'readonly', group: 'relationships' },
    { key: 'end_ref', label: 'End Ref', type: 'readonly', group: 'relationships' },
  ],
  layerStyle: { displayName: 'Dimensions', color: DIM_INK, icon: '↔', order: 90 },
  renderZIndex: 900,

  autoFillOnPlace() {
    return { dim_mode: 'aligned' };
  },

  geometry(el: CanonicalElement, ctx: GeometryContext): DimensionFacts | null {
    const g = resolveDimension(el, id => ctx.elementById(id));
    if (!g) return null;
    const m = metre();
    const angle = readableAngle(g.u);
    const a = angle * Math.PI / 180;
    const up = { x: -Math.sin(a), y: Math.cos(a) };
    const label = (el.attrs.text ?? '').trim() || formatDimension(g.value);
    const broken = [el.attrs.start_ref, el.attrs.end_ref].some(r => {
      const id = (r ?? '').split(':')[0];
      return !!id && !ctx.elementById(id);
    });
    return {
      id: el.id, ...g, label, angle, broken,
      textAt: add(mid(g.d1, g.d2), mul(up, 0.16 * m)),
    };
  },

  draw2D(f, ctx): ReactNode {
    const m = metre();
    const ink = ctx.selected ? SELECTED : DIM_INK;
    const sw = 0.02 * m;
    const tick = mul(add(f.u, f.n), 0.12 * m / Math.SQRT2);
    const lines: [Point, Point][] = [];
    const w1 = witness(f.p1, f.d1, m), w2 = witness(f.p2, f.d2, m);
    if (w1) lines.push(w1);
    if (w2) lines.push(w2);
    const fontSize = 0.22 * m;
    return (
      <g data-id={f.id}>
        {lines.map(([a, b], i) => (
          <line key={`w${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ink} strokeWidth={sw} />
        ))}
        <line x1={f.d1.x} y1={f.d1.y} x2={f.d2.x} y2={f.d2.y} stroke={ink} strokeWidth={sw}
          strokeDasharray={f.broken ? `${0.1 * m} ${0.06 * m}` : undefined} />
        {[f.d1, f.d2].map((d, i) => (
          <line key={`t${i}`} x1={d.x - tick.x} y1={d.y - tick.y} x2={d.x + tick.x} y2={d.y + tick.y}
            stroke={ink} strokeWidth={sw * 2.2} />
        ))}
        {/* Fat transparent hit band along the dimension line */}
        <line x1={f.d1.x} y1={f.d1.y} x2={f.d2.x} y2={f.d2.y} stroke="transparent" strokeWidth={0.35 * m} data-id={f.id} />
        <g transform={`translate(${f.textAt.x},${f.textAt.y}) scale(1,-1) rotate(${-f.angle})`}>
          <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize={fontSize}
            fontFamily="Inter, sans-serif" fontWeight={500} fill={ink} data-id={f.id}
            style={{ paintOrder: 'stroke' }} stroke="white" strokeWidth={0.06 * m} strokeLinejoin="round">
            {f.label}
          </text>
        </g>
      </g>
    );
  },

  draw3D(): ReactNode {
    return null;
  },

  selectionAnchor(el) {
    if (el.geometry !== 'line') return { x: 0, y: 0 };
    return mid(el.start, el.end);
  },

  selectionHandles(f, el): SelectionHandle[] {
    // Drag the text to move the dimension line (changes `offset` only, so
    // the references are kept).
    return [{
      id: 'move',
      position: mid(f.d1, f.d2),
      cursor: 'move',
      onDrag(snapped, _dragStart, snapshot) {
        if (snapshot.geometry !== 'line') return {};
        const offset = dot(sub(snapped, f.p1), f.n);
        return { attrs: { ...el.attrs, offset: fmtCoord(offset) } } as Partial<CanonicalElement>;
      },
    }];
  },
};

registerElement(dimensionModule);
