/**
 * Curtain wall — line archetype, composite element.
 * Grid, panels and members come from curtainWallLayout.ts (spec readme
 * "Curtain Wall Grids and Panels").
 * 2D: glazing strip with grid ticks, open bottom-row door cells with swings.
 * 3D: mullions / transoms / corner posts, glass or solid panels, door panels.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';
import { resolvePropertyFields } from './_propertyFields.ts';
import { doorParts } from './_opening3D.tsx';
import {
  DEFAULT_SOLID_MATERIAL, curtainCorners, curtainGrid, curtainWallPieces, doorSwings, moveGridLine,
  mullionSpec, planStripRuns,
  type CornerPost, type CornerWall, type CurtainGrid, type CwPiece, type EndMullion, type MullionSpec,
} from './curtainWallLayout.ts';
import CurtainWallPanel from './CurtainWallPanel.tsx';
import { curtainWallSpan } from '../geometry/curtainEmbed.ts';

const DEFAULT_HEIGHT = 3.0;

export interface CurtainWallFacts {
  id: string;
  start: Point;
  end: Point;
  length: number;
  angle: number;          // around Y
  uGridCount: number;     // columns: cells along the wall length
  vGridCount: number;     // rows: cells up the wall height
  height: number;
  baseY: number;
  frameMaterial: string;
  panelMaterial: string;
  solidMaterial: string;
  footprint2D: Point[];   // 2D rect strip for plan view (thin)
  grid: CurtainGrid;
  mullion: MullionSpec;
  /** Wall ends: own border mullion, shared corner post (drawn by this wall) or none (a neighbour's post). */
  ends: { start: EndMullion; end: EndMullion };
  corners: CornerPost[];
}

function resolveLevelHeight(
  attrs: Record<string, string>,
  levelElevation: number,
  levelElevations: Map<string, number>,
  unitsPerMetre: number,
): { height: number; baseOffset: number } {
  return curtainWallSpan(attrs, levelElevation, levelElevations, DEFAULT_HEIGHT * unitsPerMetre);
}

/** Corner joins of every curtain wall in scope, once per geometry pass. */
function cornersOf(ctx: GeometryContext) {
  return ctx.memo('curtain_wall:corners', () => {
    const walls: CornerWall[] = [];
    for (const el of ctx.elementsByTable('curtain_wall')) {
      if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
      const { height, baseOffset } = resolveLevelHeight(el.attrs, ctx.levelElevation, ctx.levelElevations, ctx.unitsPerMetre);
      walls.push({
        id: el.id, start: el.start, end: el.end,
        baseY: ctx.levelElevation + baseOffset, height, mullion: mullionSpec(el.attrs),
      });
    }
    return curtainCorners(walls);
  });
}

const CSV_HEADERS = [
  'number', 'base_offset', 'top_level_id', 'top_offset', 'material',
  'u_grid_count', 'v_grid_count', 'u_spacing', 'v_spacing', 'panel_count', 'panel_material',
  'v_grids', 'u_grids', 'panels', 'mullion_width', 'mullion_depth', 'mullion_profile', 'solid_material',
];
/** Edited in the curtain wall panel (CurtainWallPanel), not as plain property rows. */
const PANEL_KEYS = new Set(['v_grids', 'u_grids', 'panels', 'mullion_width', 'mullion_depth', 'mullion_profile', 'solid_material']);

const DRAWING_FIELDS: ElementModule['drawingFields'] = [
  { key: 'u_grid_count', label: 'U Grids', type: 'number', min: 0, step: 1 },
  { key: 'v_grid_count', label: 'V Grids', type: 'number', min: 0, step: 1 },
  { key: 'material', label: 'Frame', type: 'select', options: MATERIAL_OPTIONS },
  { key: 'panel_material', label: 'Panel', type: 'text' },
  BASE_OFFSET_FIELD,
];

const HIGHLIGHT = '#06b6d4';

function PieceMesh({ p, facts, hl }: { p: CwPiece; facts: CurtainWallFacts; hl: boolean }): ReactNode {
  const mat = getBimMaterial(resolveBimMaterial(p.material, 'curtain_wall'));
  const hlMat = hl ? (
    <meshStandardMaterial attach="material" color={HIGHLIGHT} transparent={mat.transparent} opacity={Math.max(mat.opacity, 0.4)} />
  ) : null;
  const cy = p.z0 + p.h / 2;
  const common = { position: [p.c.x, cy, -p.c.y] as [number, number, number], material: hl ? undefined : mat, userData: { elementId: facts.id } };
  if (p.round && p.role === 'mullion') {
    return (
      <mesh {...common} rotation={[0, p.angle, 0]} scale={[p.along, p.h, p.along]}>
        <cylinderGeometry args={[0.5, 0.5, 1, 16]} />
        {hlMat}
      </mesh>
    );
  }
  if (p.round) {
    // Transom: cylinder axis (local Y) laid along the wall.
    return (
      <mesh {...common} rotation={[0, p.angle, Math.PI / 2]} scale={[p.h, p.along, p.h]}>
        <cylinderGeometry args={[0.5, 0.5, 1, 16]} />
        {hlMat}
      </mesh>
    );
  }
  return (
    <mesh {...common} rotation={[0, p.angle, 0]} scale={[p.along, p.h, p.across]}>
      <boxGeometry args={[1, 1, 1]} />
      {hlMat}
    </mesh>
  );
}

/** Door panel: the door's frame + leaf (doorParts layout), glass leaf in the curtain wall frame material. */
function DoorPiece({ p, facts, hl }: { p: CwPiece; facts: CurtainWallFacts; hl: boolean }): ReactNode {
  const parts = doorParts({ length: p.along, height: p.h, strokeWidth: p.across, operation: p.kind === 'double_door' ? 'double_swing' : 'single_swing' });
  const frame = getBimMaterial(resolveBimMaterial(facts.frameMaterial, 'curtain_wall'));
  const leaf = getBimMaterial(resolveBimMaterial(facts.panelMaterial, 'curtain_wall'));
  return (
    <group position={[p.c.x, p.z0 + p.h / 2, -p.c.y]} rotation={[0, p.angle, 0]} userData={{ elementId: facts.id }}>
      {parts.map((q, k) => {
        const mat = q.role === 'frame' ? frame : leaf;
        return (
          <mesh key={k} position={q.pos} material={hl ? undefined : mat}>
            <boxGeometry args={q.size} />
            {hl && <meshStandardMaterial color={HIGHLIGHT} transparent={mat.transparent} opacity={Math.max(mat.opacity, 0.4)} />}
          </mesh>
        );
      })}
    </group>
  );
}

export const curtainWallModule: ElementModule<CurtainWallFacts> = {
  table: 'curtain_wall',
  discipline: 'architecture',
  archetype: 'line',
  prefix: 'cw',
  hasVerticalSpan: true,
  csvHeaders: CSV_HEADERS,
  defaults: {
    base_offset: '0', top_level_id: '', top_offset: '0', material: 'glass',
    u_grid_count: '3', v_grid_count: '3', u_spacing: '', v_spacing: '',
    panel_material: 'glass',
  },
  drawingFields: DRAWING_FIELDS,
  propertyFields: resolvePropertyFields(CSV_HEADERS.filter(k => !PANEL_KEYS.has(k)), DRAWING_FIELDS),
  layerStyle: { displayName: 'Curtain Walls', color: '#7ec8e3', icon: '⊞', order: 1.5 },
  renderZIndex: 40,
  propertyPanel: CurtainWallPanel,

  geometry(el: CanonicalElement, ctx: GeometryContext): CurtainWallFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
    const { height, baseOffset } = resolveLevelHeight(ln.attrs, ctx.levelElevation, ctx.levelElevations, ctx.unitsPerMetre);
    const baseY = ctx.levelElevation + baseOffset;
    const grid = curtainGrid(ln.attrs, len, height);

    const frameMatRaw = ln.attrs.material || 'glass';
    const frameMaterial = frameMatRaw === 'glass' ? 'aluminum' : frameMatRaw;
    const panelMaterial = ln.attrs.panel_material || 'glass';
    const solidMaterial = ln.attrs.solid_material || DEFAULT_SOLID_MATERIAL;
    const mullion = mullionSpec(ln.attrs);
    const join = cornersOf(ctx).get(ln.id);

    const hw = ln.strokeWidth / 2 || mullion.width;
    const nx = -dy / len, ny = dx / len;
    const footprint2D: Point[] = [
      { x: ln.start.x + nx * hw, y: ln.start.y + ny * hw },
      { x: ln.end.x   + nx * hw, y: ln.end.y   + ny * hw },
      { x: ln.end.x   - nx * hw, y: ln.end.y   - ny * hw },
      { x: ln.start.x - nx * hw, y: ln.start.y - ny * hw },
    ];

    return {
      id: ln.id,
      start: ln.start, end: ln.end,
      length: len,
      angle: Math.atan2(dy, dx),
      uGridCount: grid.xs.length - 1, vGridCount: grid.ys.length - 1,
      height, baseY,
      frameMaterial, panelMaterial, solidMaterial,
      footprint2D,
      grid, mullion,
      ends: join?.ends ?? { start: 'border', end: 'border' },
      corners: join?.corners ?? [],
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7ec8e3';
    const ux = (facts.end.x - facts.start.x) / facts.length;
    const uy = (facts.end.y - facts.start.y) / facts.length;
    const nx = -uy, ny = ux;
    const hw = Math.hypot(facts.footprint2D[0].x - facts.footprint2D[3].x, facts.footprint2D[0].y - facts.footprint2D[3].y) / 2;
    const at = (t: number, s: number) => `${facts.start.x + ux * t + nx * s},${facts.start.y + uy * t + ny * s}`;
    const runs = planStripRuns(facts.grid);
    const whole = runs.length === 1 && runs[0][0] === 0 && runs[0][1] === facts.length;
    const strips = whole
      ? [<polygon key="s" points={facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ')} fill="#d6eaf8" stroke={stroke} strokeWidth={0.025} />]
      : runs.map(([t0, t1], k) => (
        <polygon key={`s${k}`} points={[at(t0, hw), at(t1, hw), at(t1, -hw), at(t0, -hw)].join(' ')}
          fill="#d6eaf8" stroke={stroke} strokeWidth={0.025} />
      ));
    // Grid ticks at each interior vertical grid line.
    const tickHw = Math.max(facts.mullion.width * 2, 0.04);
    const ticks: ReactNode[] = [];
    for (let i = 1; i < facts.grid.xs.length - 1; i++) {
      const t = facts.grid.xs[i];
      const cx = facts.start.x + ux * t;
      const cy = facts.start.y + uy * t;
      ticks.push(
        <line key={i}
          x1={cx + nx * tickHw} y1={cy + ny * tickHw}
          x2={cx - nx * tickHw} y2={cy - ny * tickHw}
          stroke={stroke} strokeWidth={0.015} />
      );
    }
    const swings = doorSwings(facts).map((s, k) => (
      <g key={`d${k}`} fill="none" stroke={drawCtx.selected ? '#3a7bff' : '#5b6b7a'}>
        <line x1={s.hinge.x} y1={s.hinge.y} x2={s.tip.x} y2={s.tip.y} strokeWidth={0.02} />
        <polyline points={s.arc.map(p => `${p.x},${p.y}`).join(' ')} strokeWidth={0.01} />
      </g>
    ));
    // Corner posts drawn by this wall.
    const posts = facts.corners.map((p, k) => {
      const c = Math.cos(p.angle), s = Math.sin(p.angle), h = p.size / 2;
      const pts = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([a, b]) => `${p.at.x + a * c - b * s},${p.at.y + a * s + b * c}`).join(' ');
      return <polygon key={`c${k}`} points={pts} fill={stroke} stroke="none" />;
    });
    return (
      <g data-id={facts.id}>
        {/* Hit area over the whole wall, door bays included */}
        <polygon points={facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ')} fill="transparent" stroke="none" />
        {strips}
        {ticks}
        {swings}
        {posts}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const hl = drawCtx.selected || drawCtx.hovered;
    const meshes = curtainWallPieces(facts).map(p => (p.role === 'door'
      ? <DoorPiece key={`${p.role}${p.index}`} p={p} facts={facts} hl={hl} />
      : <PieceMesh key={`${p.role}${p.index}`} p={p} facts={facts} hl={hl} />));
    return <group>{meshes}</group>;
  },

  selectionHandles(facts, el): SelectionHandle[] | undefined {
    if (el.geometry !== 'line') return undefined;
    const handles: SelectionHandle[] = [
      { id: 'start', position: el.start, onDrag: snapped => ({ start: snapped }) },
      { id: 'end', position: el.end, onDrag: snapped => ({ end: snapped }) },
    ];
    // One handle per interior vertical grid line, sliding along the wall.
    const ux = Math.cos(facts.angle), uy = Math.sin(facts.angle);
    for (let i = 0; i < facts.grid.xs.length - 2; i++) {
      const t = facts.grid.xs[i + 1];
      handles.push({
        id: `vgrid-${i}`,
        position: { x: facts.start.x + ux * t, y: facts.start.y + uy * t },
        color: '#f59e0b',
        cursor: 'ew-resize',
        onDrag(snapped, _ds, snapshot) {
          if (snapshot.geometry !== 'line') return {};
          const pos = (snapped.x - snapshot.start.x) * ux + (snapped.y - snapshot.start.y) * uy;
          const patch = moveGridLine(curtainGrid(snapshot.attrs, facts.length, facts.height), 'v', i, pos);
          return patch ? { attrs: patch } as Partial<CanonicalElement> : {};
        },
      });
    }
    return handles;
  },
};

registerElement(curtainWallModule);
