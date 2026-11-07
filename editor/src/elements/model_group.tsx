/**
 * Model group instance (spec model_group.yaml): CSV-only row at the group
 * origin; members carry `group_id`. Drawn only while selected: a dashed box
 * around the members and the origin cross. Clicking any member selects the
 * whole instance (editorReducer SELECT).
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { elementsBounds } from '../model/transform.ts';

export interface ModelGroupFacts {
  id: string;
  name: string;
  origin: Point;
  rotation: number;
  box: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const GROUP_INK = '#2f9e44';

export const modelGroupModule: ElementModule<ModelGroupFacts> = {
  table: 'model_group',
  discipline: 'annotation',
  archetype: 'point',
  prefix: 'mg',
  csvOnly: true,
  hiddenFromToolbar: true,
  isSnapTarget: false,
  csvHeaders: ['name', 'x', 'y', 'rotation', 'mirrored'],
  defaults: { name: '', rotation: '0', mirrored: '' },
  drawingFields: [],
  propertyFields: [
    { key: 'name', label: 'Name', type: 'text', group: 'identity' },
  ],
  layerStyle: { displayName: 'Groups', color: GROUP_INK, icon: '▣', order: 95 },
  renderZIndex: 950,

  geometry(el: CanonicalElement, ctx: GeometryContext): ModelGroupFacts | null {
    if (el.geometry !== 'point') return null;
    const boxes = ctx.memo('model_group:boxes', () => {
      const byGroup = new Map<string, CanonicalElement[]>();
      for (const e of ctx.allElements.values()) {
        const g = e.attrs.group_id;
        if (!g || e.tableName === 'model_group') continue;
        const list = byGroup.get(g) ?? [];
        list.push(e);
        byGroup.set(g, list);
      }
      const out = new Map<string, ReturnType<typeof elementsBounds>>();
      for (const [g, list] of byGroup) out.set(g, elementsBounds(list));
      return out;
    });
    return {
      id: el.id,
      name: el.attrs.name ?? '',
      origin: el.position,
      rotation: parseFloat(el.attrs.rotation ?? '') || 0,
      box: boxes.get(el.id) ?? null,
    };
  },

  draw2D(f, ctx): ReactNode {
    if (!ctx.selected && !ctx.hovered) return null;
    const px = 1 / Math.max(ctx.scale, 1e-6);
    const pad = 0.15;
    const b = f.box;
    const cross = 0.25;
    return (
      <g data-id={f.id} pointerEvents="none">
        {b && (
          <rect x={b.minX - pad} y={b.minY - pad} width={b.maxX - b.minX + 2 * pad} height={b.maxY - b.minY + 2 * pad}
            fill="none" stroke={GROUP_INK} strokeWidth={1.5 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
        )}
        <g transform={`translate(${f.origin.x},${f.origin.y}) rotate(${f.rotation})`} stroke={GROUP_INK} strokeWidth={1.5 * px}>
          <line x1={-cross} y1={0} x2={cross} y2={0} />
          <line x1={0} y1={-cross} x2={0} y2={cross} />
          <circle r={cross / 3} fill="none" />
        </g>
        {b && f.name && (
          <text x={b.minX - pad} y={-(b.maxY + pad) - 4 * px} transform="scale(1,-1)" fontSize={11 * px}
            fontFamily="Inter, sans-serif" fill={GROUP_INK}>{f.name}</text>
        )}
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

registerElement(modelGroupModule);
