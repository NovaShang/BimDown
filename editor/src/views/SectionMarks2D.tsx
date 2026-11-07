import React from 'react';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { SectionDef } from './viewTypes.ts';
import { sectionFrame } from './viewGeometry.ts';

const COLOR = '#7c3aed';
const ACTIVE = '#06b6d4';

/** One section mark: dash-dot cut line, a head at each end (bubble + arrow in
 *  the view direction + label). Clicking a head opens the section. */
function SectionMark({ section, scale, active, preview, onOpen }: {
  section: Pick<SectionDef, 'start' | 'end' | 'name'>;
  scale: number;
  active?: boolean;
  preview?: boolean;
  onOpen?: () => void;
}) {
  const f = sectionFrame(section.start, section.end);
  if (!f) return null;
  const color = active ? ACTIVE : COLOR;
  const r = 0.42 / scale;
  const sw = 0.07 / scale;
  const dash = `${0.6 / scale},${0.15 / scale},${0.1 / scale},${0.15 / scale}`;
  // Heads sit just outside the line ends; arrows point along the view direction.
  const heads = [
    { x: section.start.x - f.right.x * r, y: section.start.y - f.right.y * r },
    { x: section.end.x + f.right.x * r, y: section.end.y + f.right.y * r },
  ];
  const arrow = (h: { x: number; y: number }) => {
    const tip = { x: h.x + f.dir.x * r * 2.1, y: h.y + f.dir.y * r * 2.1 };
    const b1 = { x: h.x + f.right.x * r * 0.75, y: h.y + f.right.y * r * 0.75 };
    const b2 = { x: h.x - f.right.x * r * 0.75, y: h.y - f.right.y * r * 0.75 };
    return `${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`;
  };
  const open = (e: React.PointerEvent) => {
    if (!onOpen || e.button !== 0) return;
    e.stopPropagation();
    onOpen();
  };
  return (
    <g opacity={preview ? 0.6 : 1} data-section-mark="">
      <line x1={section.start.x} y1={section.start.y} x2={section.end.x} y2={section.end.y}
        stroke={color} strokeWidth={sw * 1.4} strokeDasharray={dash} pointerEvents="none" />
      {heads.map((h, i) => (
        <g key={i} style={{ cursor: onOpen ? 'pointer' : undefined }} onPointerDown={open}>
          <polygon points={arrow(h)} fill={color} />
          <circle cx={h.x} cy={h.y} r={r} fill="white" stroke={color} strokeWidth={sw} />
          <text x={h.x} y={-h.y} transform="scale(1,-1)" fontSize={0.42 / scale} fontWeight={600}
            textAnchor="middle" dominantBaseline="central" fill={color} style={{ userSelect: 'none' }}>
            {section.name || '?'}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Saved section lines in the plan, plus the rubber band while drawing one. */
export default function SectionMarks2D({ scale }: { scale: number }) {
  const { project, views, activeTool, drawingState } = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const sections = project?.sections ?? [];
  const drawing = activeTool === 'draw_section' && drawingState?.points.length === 1 && drawingState.cursor;
  if (sections.length === 0 && !drawing) return null;
  const openId = views.open?.kind === 'section' ? views.open.id : null;
  return (
    <g className="section-marks" transform="scale(1,-1)">
      {sections.map(s => (
        <SectionMark key={s.id} section={s} scale={scale} active={s.id === openId}
          onOpen={() => dispatch({ type: 'OPEN_VIEW', view: { kind: 'section', id: s.id } })} />
      ))}
      {drawing && (
        <SectionMark section={{ start: drawingState!.points[0], end: drawingState!.cursor!, name: '' }} scale={scale} preview />
      )}
    </g>
  );
}
