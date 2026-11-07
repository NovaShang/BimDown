import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { ANNOTATION_DISCIPLINE, TAG_HEADERS, isTagPinned, type TagElement } from '../annotation/model.ts';
import {
  tagLines, tagDefaultPosition, tagBox, elementAnchor, metre, sub, len,
} from '../annotation/geometry.ts';
import { roomPolygonFromCtx, polygonArea } from '../annotation/rooms.ts';
import { DIM_INK } from './dimension.tsx';

export interface TagFacts {
  id: string;
  position: Point;
  /** Host anchor — leader target. */
  anchor: Point;
  lines: string[];
  room: boolean;
  leader: boolean;
  w: number; h: number; size: number;
}

/** Where a tag is drawn right now: pinned position; for an unpinned tag the
 *  host's live default spot, unless the tag itself is mid-drag (position has
 *  left its last resolved base). */
export function tagPosition(el: CanonicalElement, host: CanonicalElement, lookup: (id: string) => CanonicalElement | undefined): Point {
  if (el.geometry !== 'point') return { x: 0, y: 0 };
  if (isTagPinned(el)) return el.position;
  const base = (el as TagElement).tagBase;
  if (base && len(sub(el.position, base)) > 1e-6) return el.position;
  return tagDefaultPosition(host, lookup);
}

export const tagModule: ElementModule<TagFacts> = {
  table: 'tag',
  discipline: ANNOTATION_DISCIPLINE,
  archetype: 'point',
  prefix: 'tg',
  csvOnly: true,
  hiddenFromToolbar: true,
  isSnapTarget: false,
  csvHeaders: TAG_HEADERS,
  defaults: { host_id: '', x: '', y: '', content: 'auto' },
  drawingFields: [
    {
      key: 'content', label: 'Shows', type: 'select', options: [
        { value: 'auto', label: 'Auto' },
        { value: 'number', label: 'Number' },
        { value: 'name', label: 'Name' },
        { value: 'type', label: 'Type' },
        { value: 'size', label: 'Size' },
        { value: 'area', label: 'Area' },
      ],
    },
  ],
  propertyFields: [
    { key: 'host_id', label: 'Host', type: 'readonly', group: 'relationships' },
    {
      key: 'content', label: 'Shows', type: 'select', group: 'identity', options: [
        { value: 'auto', label: 'Auto' },
        { value: 'number', label: 'Number' },
        { value: 'name', label: 'Name' },
        { value: 'type', label: 'Type' },
        { value: 'size', label: 'Size' },
        { value: 'area', label: 'Area' },
      ],
    },
  ],
  layerStyle: { displayName: 'Tags', color: DIM_INK, icon: '◇', order: 92 },
  renderZIndex: 902,

  geometry(el: CanonicalElement, ctx: GeometryContext): TagFacts | null {
    if (el.geometry !== 'point') return null;
    const host = ctx.elementById(el.attrs.host_id ?? '');
    if (!host) return null;
    const lookup = (id: string) => ctx.elementById(id);
    const room = host.tableName === 'space';
    const poly = room ? roomPolygonFromCtx(host, ctx) : null;
    const lines = tagLines(host, el.attrs.content, poly ? polygonArea(poly) : null);
    const position = tagPosition(el, host, lookup);
    const anchor = elementAnchor(host);
    const box = tagBox(lines, room);
    return {
      id: el.id, position, anchor, lines, room,
      leader: isTagPinned(el) && len(sub(anchor, position)) > 0.6 * metre(),
      ...box,
    };
  },

  draw2D(f, ctx): ReactNode {
    const m = metre();
    const ink = ctx.selected ? '#3a7bff' : DIM_INK;
    const { x, y } = f.position;
    const lh = f.size * 1.25;
    return (
      <g data-id={f.id}>
        {f.leader && (
          <>
            <line x1={f.anchor.x} y1={f.anchor.y} x2={x} y2={y} stroke={ink} strokeWidth={0.015 * m} />
            <circle cx={f.anchor.x} cy={f.anchor.y} r={0.04 * m} fill={ink} />
          </>
        )}
        <g transform={`translate(${x},${y}) scale(1,-1)`}>
          <rect x={-f.w / 2} y={-f.h / 2} width={f.w} height={f.h} rx={0.05 * m}
            fill={f.room ? (ctx.selected ? 'rgba(58,123,255,0.1)' : 'rgba(255,255,255,0.01)') : 'white'}
            stroke={f.room ? (ctx.selected ? ink : 'none') : ink} strokeWidth={0.015 * m} data-id={f.id} />
          {f.lines.map((line, i) => (
            <text key={i} x={0} y={(i - (f.lines.length - 1) / 2) * lh} textAnchor="middle" dominantBaseline="central"
              fontSize={f.room && i === 0 ? f.size * 1.1 : f.size} fontWeight={i === 0 ? 600 : 400}
              fontFamily="Inter, sans-serif" fill={f.room ? (ctx.selected ? ink : '#1f4e9c') : ink} data-id={f.id}>
              {line}
            </text>
          ))}
        </g>
      </g>
    );
  },

  draw3D(): ReactNode {
    return null;
  },

  selectionAnchor(el) {
    return el.geometry === 'point' ? el.position : { x: 0, y: 0 };
  },

  selectionHandles(): SelectionHandle[] {
    return [];
  },
};

registerElement(tagModule);
