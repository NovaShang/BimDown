import type { ReactNode } from 'react';
import type { ElementModule, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { ANNOTATION_DISCIPLINE, TEXT_NOTE_HEADERS } from '../annotation/model.ts';
import { metre, textWidth } from '../annotation/geometry.ts';
import { DIM_INK } from './dimension.tsx';

export interface TextNoteFacts {
  id: string;
  position: Point;
  lines: string[];
  size: number;
  rotation: number;
  width: number;
}

export function textNoteLines(text: string | undefined): string[] {
  return (text ?? '').split(/\\n|\n/);
}

export const textNoteModule: ElementModule<TextNoteFacts> = {
  table: 'text_note',
  discipline: ANNOTATION_DISCIPLINE,
  archetype: 'point',
  prefix: 'tx',
  csvOnly: true,
  hiddenFromToolbar: true,
  isSnapTarget: false,
  csvHeaders: TEXT_NOTE_HEADERS,
  defaults: { text: '', size: '0.25', rotation: '0' },
  drawingFields: [
    { key: 'size', label: 'Text Size', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
  ],
  propertyFields: [
    { key: 'text', label: 'Text', type: 'text', group: 'identity' },
    { key: 'size', label: 'Text Size', type: 'number', unit: 'm', min: 0.05, step: 0.05, group: 'geometry' },
    { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', step: 15, group: 'geometry' },
  ],
  layerStyle: { displayName: 'Text Notes', color: DIM_INK, icon: 'T', order: 91 },
  renderZIndex: 901,

  geometry(el: CanonicalElement): TextNoteFacts | null {
    if (el.geometry !== 'point') return null;
    const lines = textNoteLines(el.attrs.text);
    if (lines.every(l => !l.trim())) return null;
    const size = parseFloat(el.attrs.size ?? '') || 0.25 * metre();
    return {
      id: el.id, position: el.position, lines, size,
      rotation: parseFloat(el.attrs.rotation ?? '') || 0,
      width: Math.max(...lines.map(l => textWidth(l, size))),
    };
  },

  draw2D(f, ctx): ReactNode {
    const { x, y } = f.position;
    const lh = f.size * 1.25;
    const h = f.lines.length * lh;
    const ink = ctx.selected ? '#3a7bff' : DIM_INK;
    return (
      <g data-id={f.id} transform={`translate(${x},${y}) scale(1,-1) rotate(${-f.rotation})`}>
        <rect x={-f.width / 2 - 0.05} y={-h / 2 - 0.04} width={f.width + 0.1} height={h + 0.08}
          fill={ctx.selected ? 'rgba(58,123,255,0.08)' : 'transparent'}
          stroke={ctx.selected ? ink : 'none'} strokeWidth={0.015} strokeDasharray="0.06 0.04" data-id={f.id} />
        {f.lines.map((line, i) => (
          <text key={i} x={0} y={(i - (f.lines.length - 1) / 2) * lh} textAnchor="middle" dominantBaseline="central"
            fontSize={f.size} fontFamily="Inter, sans-serif" fill={ink} data-id={f.id}>
            {line}
          </text>
        ))}
      </g>
    );
  },

  draw3D(): ReactNode {
    return null;
  },

  selectionAnchor(el) {
    return el.geometry === 'point' ? el.position : { x: 0, y: 0 };
  },

  // Move by dragging the text; no resize corners.
  selectionHandles(): SelectionHandle[] {
    return [];
  },
};

registerElement(textNoteModule);
