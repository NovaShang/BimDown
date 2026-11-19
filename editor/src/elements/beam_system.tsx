/**
 * Beam system (spec beam_system.yaml): the bay of an associative set of
 * infill beams. Plan: a thin dash-dot boundary with a direction line and a
 * "spacing" label; no 3D body (its beams are the members). Editing it
 * regenerates the beams (model/beamSystem.ts, state/editorReducer.ts).
 */
import type { ReactNode } from 'react';
import type { ElementModule } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point, PolygonElement } from '../model/elements.ts';
import { MATERIAL_GRADE_FIELD } from './_options.ts';
import { systemDirection, systemSpacing } from '../model/beamSystem.ts';
import { PlanTag } from './_planTag.tsx';

export interface BeamSystemFacts {
  id: string;
  vertices: Point[];
  center: Point;
  direction: number;
  spacing: number;
  number: string;
}

function centroid(vs: readonly Point[]): Point {
  const n = vs.length || 1;
  return { x: vs.reduce((s, p) => s + p.x, 0) / n, y: vs.reduce((s, p) => s + p.y, 0) / n };
}

export const beamSystemModule: ElementModule<BeamSystemFacts> = {
  table: 'beam_system',
  discipline: 'structure',
  archetype: 'surface',
  prefix: 'bs',
  csvHeaders: ['number', 'spacing', 'direction', 'type_id', 'material_grade'],
  defaults: { spacing: '2' },
  drawingFields: [
    { key: 'spacing', label: 'Spacing', type: 'number', unit: 'm', min: 0.3, step: 0.1 },
    { key: 'direction', label: 'Direction', type: 'number', unit: '°', step: 15 },
    MATERIAL_GRADE_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Beam Systems', color: '#8d6e63', icon: '▥', order: 16.5 },
  renderZIndex: 32,

  geometry(el: CanonicalElement): BeamSystemFacts | null {
    if (el.geometry !== 'polygon' || el.vertices.length < 3) return null;
    const p = el as PolygonElement;
    return {
      id: p.id, vertices: p.vertices, center: centroid(p.vertices),
      direction: systemDirection(p), spacing: systemSpacing(p), number: p.attrs.number || '',
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : (drawCtx.hovered ? '#06b6d4' : '#8d6e63');
    const a = (facts.direction * Math.PI) / 180;
    const c = facts.center, r = 0.8;
    const p1 = { x: c.x - Math.cos(a) * r, y: c.y - Math.sin(a) * r }, p2 = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    const pts = facts.vertices.map(p => `${p.x},${p.y}`).join(' ');
    return (
      <g data-id={facts.id}>
        <polygon points={pts} fill={drawCtx.selected ? 'rgba(58,123,255,0.08)' : 'transparent'} stroke={stroke}
          strokeWidth={0.015} strokeDasharray="0.3 0.08 0.05 0.08" />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={0.02} />
        <PlanTag x={c.x} y={c.y + 0.3} text={`${facts.number ? `${facts.number} ` : ''}@${Math.round(facts.spacing * 1000) / 1000}`}
          color={stroke} angleDeg={0} size={0.22} />
      </g>
    );
  },

  draw3D(): ReactNode {
    return null;
  },

  bbox(facts) {
    const xs = facts.vertices.map(p => p.x), ys = facts.vertices.map(p => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  },
};

registerElement(beamSystemModule);
