import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';

export interface RoomSeparatorFacts {
  id: string;
  start: Point;
  end: Point;
}

export const roomSeparatorModule: ElementModule<RoomSeparatorFacts> = {
  table: 'room_separator',
  discipline: 'architecture',
  archetype: 'line',
  prefix: 'rs',
  csvHeaders: ['number', 'base_offset'],
  defaults: { base_offset: '0' },
  drawingFields: [],
  propertyFields: [],
  layerStyle: { displayName: 'Room Separators', color: '#adb5bd', icon: '╌', order: 6.5 },
  renderZIndex: 15,

  geometry(el: CanonicalElement, _ctx: GeometryContext): RoomSeparatorFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    return { id: ln.id, start: ln.start, end: ln.end };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#000');
    return (
      <line
        x1={facts.start.x} y1={facts.start.y}
        x2={facts.end.x} y2={facts.end.y}
        stroke={stroke} strokeWidth={0.03}
        strokeDasharray="0.15 0.08"
        strokeLinecap="butt"
        data-id={facts.id}
      />
    );
  },

  draw3D(): ReactNode {
    return null;
  },
};

registerElement(roomSeparatorModule);
