import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, PointElement, PolygonElement, Point } from '../model/elements.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';
import { getSpaceFaceGraph, findSpaceBoundary, BOUNDARY_TABLES } from '../geometry/spaceBoundary.ts';
// Pull the i18next singleton directly. Importing `../i18n/i18n.ts` instead
// would drag the editor's bootstrap `.init()` call into any host that
// imports this module — and the host (e.g. the BimClaw web app) has its
// own merged resources, so a second init wipes them out.
import i18n from 'i18next';
import { boundaryWallsFromCtx, redundantRoomsFromCtx, roomAreasOf } from '../annotation/rooms.ts';
import { formatArea } from '../annotation/geometry.ts';

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
  /** Net area at the wall faces (polygon rooms), for the plain label. */
  area?: number;
  /** A tag labels this room — the plain label steps aside. */
  tagged?: boolean;
  /** Redundant room (annotation/rooms.ts): the room already occupying this area. */
  redundantOf?: string;
}

/** Rooms that have a tag on this level (one scan per render pass). */
function taggedRooms(ctx: GeometryContext): Set<string> {
  return ctx.memo('space-tagged', () => new Set(ctx.elementsByTable('tag').map(t => t.attrs.host_id ?? '')));
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
      // Try to derive a boundary polygon from surrounding walls. The face
      // graph is built once per wall set (cached across passes on the wall
      // geometry, see getSpaceFaceGraph) and fetched once per pass via
      // ctx.memo; each seed then only looks up its enclosing face.
      const graph = ctx.memo('space-boundary:graph', () => {
        const walls: LineElement[] = [];
        for (const table of BOUNDARY_TABLES) {
          for (const e of ctx.elementsByTable(table)) {
            if (e.geometry === 'line') walls.push(e as LineElement);
          }
        }
        return getSpaceFaceGraph(walls);
      });
      const derived = ctx.memo<Point[] | null>(`space-boundary:${el.id}`, () =>
        findSpaceBoundary(graph, pt.position),
      );
      if (derived && derived.length >= 3) {
        // CSV row remains a point seed; facts upgrade to polygon so draw2D
        // can render the derived outline + filled interior. The anchor stays
        // on the seed (not the polygon centroid) so the label, the move
        // handle and the user's click point all line up — moving the seed
        // visually moves everything together.
        const redundantOf = redundantRoomsFromCtx(ctx).get(el.id);
        return {
          id: el.id, kind: 'polygon', anchor: pt.position, vertices: derived, number, name,
          area: redundantOf ? 0 : roomAreasOf(derived, boundaryWallsFromCtx(ctx)).area, tagged: taggedRooms(ctx).has(el.id),
          ...(redundantOf ? { redundantOf } : {}),
        };
      }
      return { id: el.id, kind: 'point', anchor: pt.position, number, name, tagged: taggedRooms(ctx).has(el.id) };
    }
    if (el.geometry === 'polygon') {
      const poly = el as PolygonElement;
      if (poly.vertices.length < 3) return null;
      return {
        id: el.id, kind: 'polygon',
        anchor: centroid(poly.vertices),
        vertices: poly.vertices,
        number, name, area: roomAreasOf(poly.vertices, boundaryWallsFromCtx(ctx)).area, tagged: taggedRooms(ctx).has(el.id),
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

    // Redundant room (Revit): a second room in an occupied area — flagged, area 0.
    const redundant = facts.redundantOf ? (() => {
      const { x, y } = facts.anchor;
      const ry = y + NAME_LABEL_OFFSET;
      return (
        <g>
          <circle cx={x} cy={y} r={0.18} fill="none" stroke="#dc2626" strokeWidth={0.04} />
          <text x={x} y={ry} textAnchor="middle" dominantBaseline="central"
            fontSize={0.2} fontFamily="Inter, sans-serif" fontWeight={600} fill="#dc2626"
            transform={`translate(${x},${ry}) scale(1,-1) translate(${-x},${-ry})`}>
            {i18n.t('space.redundant', { defaultValue: 'Redundant room' })}
          </text>
        </g>
      );
    })() : null;

    if ((!facts.number && !facts.name) || facts.tagged) {
      if (drawCtx.labels === 'only') return null;
      return <g data-id={facts.id}>{outline}{marker}{redundant}</g>;
    }
    const { x, y } = facts.anchor;
    // Revit room tag style: the name big, the number small under it, then the area
    const big = facts.name || facts.number;
    const small = facts.name ? facts.number : '';
    const areaY = y - NAME_LABEL_OFFSET - (small ? 0.3 : 0);
    const label = (text: string, ty: number, size: number, weight: number, fill: string) => (
      <text x={x} y={ty} textAnchor="middle" dominantBaseline="central"
        fontSize={size} fontFamily="Inter, sans-serif" fontWeight={weight} fill={fill}
        transform={`translate(${x},${ty}) scale(1,-1) translate(${-x},${-ty})`}>
        {text}
      </text>
    );
    const roomLabel = (
      <g className="room-label">
        {label(big, y, 0.36, 700, '#3a86ff')}
        {small && label(small, y - NAME_LABEL_OFFSET, 0.22, 500, '#5a9fff')}
        {facts.area !== undefined && facts.area > 0 && label(formatArea(facts.area), areaY, 0.18, 400, '#7aa7ff')}
      </g>
    );
    // The label pass over furniture and equipment (SVGLayers) draws the label alone
    if (drawCtx.labels === 'only') return <g data-id={facts.id}>{roomLabel}</g>;
    if (drawCtx.labels === 'none') return <g data-id={facts.id}>{outline}{marker}{redundant}</g>;
    return (
      <g data-id={facts.id}>
        {outline}
        {marker}
        {redundant}
        {/* Drawn again over furniture and equipment (SVGLayers' room label pass) */}
        <g className="room-label">
          {label(big, y, 0.36, 700, '#3a86ff')}
          {small && label(small, y - NAME_LABEL_OFFSET, 0.22, 500, '#5a9fff')}
          {facts.area !== undefined && facts.area > 0 && label(formatArea(facts.area), areaY, 0.18, 400, '#7aa7ff')}
        </g>
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

  autoFillOnPlace(existing) {
    // Next number after the highest numeric room number (or the count), so
    // deleting a room never hands out a number that is still in use.
    let n = existing.length;
    for (const el of existing) {
      const v = parseInt(el.attrs.number ?? '', 10);
      if (Number.isFinite(v) && String(v) === (el.attrs.number ?? '').trim() && v > n) n = v;
    }
    n += 1;
    return { number: String(n), name: i18n.t('space.defaultName', { n, defaultValue: `Room ${n}` }) };
  },
};

registerElement(spaceModule);
