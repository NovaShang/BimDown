/**
 * The elements of a dormer (geometry/dormer.ts layout): roof opening hosted
 * on the main roof, the dormer roof, front and cheek walls attached to it.
 * Normal rows, created together as one undo step; nothing links them
 * afterwards beyond the opening's host and the walls' top attach.
 */
import type { CanonicalElement, LineElement, PolygonElement } from './elements.ts';
import { generateId } from './ids.ts';
import { defaultAttrs } from './defaults.ts';
import { formatNumberList } from '../geometry/roofSolver.ts';
import type { DormerLayout } from '../geometry/dormer.ts';

export interface DormerPlacement {
  layout: DormerLayout;
  /** The main roof the opening is cut in. */
  hostRoofId: string;
  levelId: string;
  existingIds: Iterable<string>;
  wallThickness: number;
  roofThickness: number;
  material: string;
  wallMaterial: string;
}

export function dormerElements(p: DormerPlacement): CanonicalElement[] {
  const ids = new Set(p.existingIds);
  const take = (table: string) => {
    const id = generateId(table, ids);
    ids.add(id);
    return id;
  };
  const L = p.layout;
  const roofId = take('roof');
  const roof: PolygonElement = {
    id: roofId, tableName: 'roof', discipline: 'architecture', geometry: 'polygon',
    vertices: L.roof,
    attrs: {
      ...defaultAttrs('roof', p.levelId), id: roofId,
      roof_type: L.roofType, slope: String(Math.max(...L.edgeSlopes)), edge_slopes: formatNumberList(L.edgeSlopes),
      base_offset: String(L.roofBase), thickness: String(p.roofThickness), material: p.material,
    },
  };
  const openingId = take('opening');
  const opening: PolygonElement = {
    id: openingId, tableName: 'opening', discipline: 'architecture', geometry: 'polygon',
    vertices: L.opening, hostId: p.hostRoofId,
    attrs: {
      ...defaultAttrs('opening', p.levelId), id: openingId, host_id: p.hostRoofId,
      position: '', width: '', height: '', shape: '', base_offset: '0', top_level_id: '', top_offset: '0',
    },
  };
  const walls: LineElement[] = L.walls.map(w => {
    const id = take('wall');
    return {
      id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
      start: w.start, end: w.end, strokeWidth: p.wallThickness,
      attrs: {
        ...defaultAttrs('wall', p.levelId), id,
        thickness: String(p.wallThickness), material: p.wallMaterial,
        base_offset: String(w.baseOffset), top_level_id: p.levelId, top_offset: String(w.top),
        top_attach_id: roofId,
      },
    };
  });
  return [opening, roof, ...walls];
}
