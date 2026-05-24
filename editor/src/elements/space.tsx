import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, PointElement, PolygonElement, Point } from '../model/elements.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';
import { deriveSpaceBoundary, BOUNDARY_TABLES } from '../geometry/spaceBoundary.ts';
// Pull the i18next singleton directly. Importing `../i18n/i18n.ts` instead
// would drag the editor's bootstrap `.init()` call into any host that
// imports this module — and the host (e.g. the BimClaw web app) has its
// own merged resources, so a second init wipes them out.
import i18n from 'i18next';

/** Vertical offset (in model units) between the seed and the rendered name
 *  label. Same number is used by both draw2D and the selection handle so the
 *  user's eye lands exactly on the visible text. */
const NAME_LABEL_OFFSET = 0.45;

export interface SpaceFacts {
  id: string;
  kind: 'point' | 'polygon';
  /** Anchor point — point.position or polygon centroid. */
  anchor: Point;
  vertices?: Point[];
  number: string;
  name: string;
}

function centroid(vertices: Point[]): Point {
  let area = 0, cx = 0, cy = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10) {
    const sx = vertices.reduce((s, v) => s + v.x, 0) / n;
    const sy = vertices.reduce((s, v) => s + v.y, 0) / n;
    return { x: sx, y: sy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export const spaceModule: ElementModule<SpaceFacts> = {
  table: 'space',
  discipline: 'architecture',
  archetype: 'point',  // typically a seed point; legacy polygon still supported
  prefix: 'sp',
  csvOnly: true,
  csvHeaders: ['number', 'base_offset', 'x', 'y', 'name'],
  defaults: { base_offset: '0', x: '0', y: '0', name: '' },
  drawingFields: [
    { key: 'name', label: 'Name', type: 'text' },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Spaces', color: '#3a86ff', icon: '⬡', order: 6 },
  renderZIndex: 10,
  isSnapTarget: false,

  geometry(el: CanonicalElement, ctx: GeometryContext): SpaceFacts | null {
    const number = el.attrs.number || '';
    const name = el.attrs.name || '';
    if (el.geometry === 'point') {
      const pt = el as PointElement;
      // Try to derive a boundary polygon from surrounding walls. Shared once
      // per render pass across all space elements via ctx.memo (keyed on the
      // boundary-table contents) so the half-edge structure is built only
      // once per pass even when many seeds live on the same level.
      const walls = ctx.memo<LineElement[]>('space-boundary:walls', () => {
        const collected: LineElement[] = [];
        for (const table of BOUNDARY_TABLES) {
          for (const e of ctx.elementsByTable(table)) {
            if (e.geometry === 'line') collected.push(e as LineElement);
          }
        }
        return collected;
      });
      const derived = ctx.memo<Point[] | null>(`space-boundary:${el.id}`, () =>
        deriveSpaceBoundary(pt.position, walls),
      );
      if (derived && derived.length >= 3) {
        // CSV row remains a point seed; facts upgrade to polygon so draw2D
        // can render the derived outline + filled interior. The anchor stays
        // on the seed (not the polygon centroid) so the label, the move
        // handle and the user's click point all line up — moving the seed
        // visually moves everything together.
        return { id: el.id, kind: 'polygon', anchor: pt.position, vertices: derived, number, name };
      }
      return { id: el.id, kind: 'point', anchor: pt.position, number, name };
    }
    if (el.geometry === 'polygon') {
      const poly = el as PolygonElement;
      if (poly.vertices.length < 3) return null;
      return {
        id: el.id, kind: 'polygon',
        anchor: centroid(poly.vertices),
        vertices: poly.vertices,
        number, name,
      };
    }
    return null;
  },

  draw2D(facts, drawCtx): ReactNode {
    // Polygon spaces: dashed outline. Selection turns the boundary solid
    // and fills the interior to make the room's extent obvious.
    const highlight = drawCtx.selected;
    const outline = facts.kind === 'polygon' && facts.vertices ? (
      <polygon
        points={facts.vertices.map(v => `${v.x},${v.y}`).join(' ')}
        fill={highlight ? 'rgba(58,134,255,0.18)' : 'rgba(58,134,255,0.06)'}
        stroke={highlight ? '#3a7bff' : '#3a86ff'}
        strokeWidth={highlight ? 0.05 : 0.03}
        strokeDasharray={highlight ? undefined : '0.15,0.08'}
      />
    ) : null;

    // Point space marker — always render a small dot so the seed is visible
    // even when the user hasn't named the room yet. Otherwise placing a
    // space looks like "no reaction" (rooms only become visible once a
    // boundary is derived from surrounding walls).
    const marker = facts.kind === 'point' ? (
      <circle
        cx={facts.anchor.x} cy={facts.anchor.y} r={0.12}
        fill="rgba(58,134,255,0.2)" stroke={highlight ? '#3a7bff' : '#3a86ff'}
        strokeWidth={0.025} strokeDasharray="0.05 0.03"
      />
    ) : null;

    if (!facts.number && !facts.name) {
      return <g data-id={facts.id}>{outline}{marker}</g>;
    }
    const { x, y } = facts.anchor;
    return (
      <g data-id={facts.id}>
        {outline}
        {marker}
        {facts.number && (
          <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
            fontSize={0.4} fontFamily="Inter, sans-serif" fontWeight={700} fill="#3a86ff"
            transform={`translate(${x},${y}) scale(1,-1) translate(${-x},${-y})`}>
            {facts.number}
          </text>
        )}
        {facts.name && (
          <text x={x} y={y - NAME_LABEL_OFFSET} textAnchor="middle" dominantBaseline="central"
            fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={500} fill="#5a9fff"
            transform={`translate(${x},${y - NAME_LABEL_OFFSET}) scale(1,-1) translate(${-x},${-(y - NAME_LABEL_OFFSET)})`}>
            {facts.name}
          </text>
        )}
      </g>
    );
  },

  draw3D(): ReactNode {
    // V1: spaces don't render visible 3D mesh (they're labels in 2D).
    return null;
  },

  selectionAnchor(el) {
    // Pure on raw element so the overlay bar can be computed without running
    // geometry (useOverlayItems lives above the geometry provider). For
    // polygon-stored spaces we still hit the polygon centroid; the common
    // case is point-stored with derived polygon, which lands on the seed
    // (matches where the labels are drawn).
    if (el.geometry === 'polygon' && el.vertices.length >= 3) {
      // Inline area-weighted centroid (same formula as space.geometry's centroid()).
      let area = 0, cx = 0, cy = 0;
      const n = el.vertices.length;
      for (let i = 0; i < n; i++) {
        const a = el.vertices[i], b = el.vertices[(i + 1) % n];
        const cross = a.x * b.y - b.x * a.y;
        area += cross;
        cx += (a.x + b.x) * cross;
        cy += (a.y + b.y) * cross;
      }
      area /= 2;
      const ax = Math.abs(area) < 1e-10
        ? el.vertices.reduce((s, v) => s + v.x, 0) / n
        : cx / (6 * area);
      const ay = Math.abs(area) < 1e-10
        ? el.vertices.reduce((s, v) => s + v.y, 0) / n
        : cy / (6 * area);
      return { x: ax, y: ay - NAME_LABEL_OFFSET };
    }
    if (el.geometry === 'point') {
      return { x: el.position.x, y: el.position.y - NAME_LABEL_OFFSET };
    }
    return { x: 0, y: 0 };
  },

  selectionHandles(_facts, el): SelectionHandle[] {
    // Anchor the handle to the seed (offset by the label distance), not to
    // facts.anchor — facts.anchor is the derived polygon centroid, which is
    // invariant to small seed movements within the same room. Pinning the
    // handle to that centroid makes it look "stuck" while the user drags
    // inside the room. The seed always tracks the cursor 1:1.
    if (el.geometry !== 'point') return [];
    const seedX = el.position.x;
    const seedY = el.position.y;
    return [{
      id: 'move',
      position: { x: seedX, y: seedY - NAME_LABEL_OFFSET },
      cursor: 'move',
      onDrag(snapped, dragStart, snapshot) {
        if (snapshot.geometry !== 'point') return {};
        const dx = snapped.x - dragStart.x;
        const dy = snapped.y - dragStart.y;
        return { position: { x: snapshot.position.x + dx, y: snapshot.position.y + dy } };
      },
    }];
  },

  autoFillOnPlace(existingCount) {
    const n = existingCount + 1;
    return { name: i18n.t('space.defaultName', { n, defaultValue: `Room ${n}` }) };
  },
};

registerElement(spaceModule);
