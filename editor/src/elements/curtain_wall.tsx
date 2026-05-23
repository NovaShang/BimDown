/**
 * Curtain wall — line archetype, composite element.
 * 2D: filled rect strip with grid lines.
 * 3D: vertical/horizontal mullion boxes + glass panel boxes per cell.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { BASE_OFFSET_FIELD, MATERIAL_OPTIONS } from './_options.ts';

const DEFAULT_HEIGHT = 3.0;
const MULLION_SIZE = 0.05;
const PANEL_THICKNESS = 0.006;

export interface CurtainWallFacts {
  id: string;
  start: Point;
  end: Point;
  length: number;
  angle: number;          // around Y
  uGridCount: number;     // horizontal cells along wall length
  vGridCount: number;     // vertical cells along wall height
  height: number;
  baseY: number;
  frameMaterial: string;
  panelMaterial: string;
  footprint2D: Point[];   // 2D rect strip for plan view (thin)
}

function resolveLevelHeight(
  attrs: Record<string, string>,
  levelElevation: number,
  levelElevations: Map<string, number>,
): { height: number; baseOffset: number } {
  const baseOffset = parseFloat(attrs.base_offset || '0') || 0;
  const topLevelId = attrs.top_level_id;
  if (topLevelId && levelElevations.has(topLevelId)) {
    const topEl = levelElevations.get(topLevelId)!;
    const topOff = parseFloat(attrs.top_offset || '0') || 0;
    return {
      height: Math.max(0.01, (topEl + topOff) - (levelElevation + baseOffset)),
      baseOffset,
    };
  }
  return { height: DEFAULT_HEIGHT, baseOffset };
}

export const curtainWallModule: ElementModule<CurtainWallFacts> = {
  table: 'curtain_wall',
  discipline: 'architecture',
  archetype: 'line',
  prefix: 'cw',
  hasVerticalSpan: true,
  csvHeaders: [
    'number', 'base_offset', 'top_level_id', 'top_offset', 'material',
    'u_grid_count', 'v_grid_count', 'u_spacing', 'v_spacing', 'panel_count', 'panel_material',
  ],
  defaults: {
    base_offset: '0', top_level_id: '', top_offset: '0', material: 'glass',
    u_grid_count: '3', v_grid_count: '3', u_spacing: '', v_spacing: '',
    panel_material: 'glass',
  },
  drawingFields: [
    { key: 'u_grid_count', label: 'U Grids', type: 'number', min: 0, step: 1 },
    { key: 'v_grid_count', label: 'V Grids', type: 'number', min: 0, step: 1 },
    { key: 'material', label: 'Frame', type: 'select', options: MATERIAL_OPTIONS },
    { key: 'panel_material', label: 'Panel', type: 'text' },
    BASE_OFFSET_FIELD,
  ],
  propertyFields: [],
  layerStyle: { displayName: 'Curtain Walls', color: '#7ec8e3', icon: '⊞', order: 1.5 },
  renderZIndex: 40,

  geometry(el: CanonicalElement, ctx: GeometryContext): CurtainWallFacts | null {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
    const ln = el as LineElement;
    const dx = ln.end.x - ln.start.x;
    const dy = ln.end.y - ln.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return null;
    const { height, baseOffset } = resolveLevelHeight(ln.attrs, ctx.levelElevation, ctx.levelElevations);
    const baseY = ctx.levelElevation + baseOffset;
    // Match V1: v_grid_count → horizontal cells, u_grid_count → vertical cells.
    const uGridCount = Math.max(1, parseInt(ln.attrs.v_grid_count || '3', 10) || 3);
    const vGridCount = Math.max(1, parseInt(ln.attrs.u_grid_count || '3', 10) || 3);

    const frameMatRaw = ln.attrs.material || 'glass';
    const frameMaterial = frameMatRaw === 'glass' ? 'aluminum' : frameMatRaw;
    const panelMaterial = ln.attrs.panel_material || 'glass';

    const hw = ln.strokeWidth / 2 || MULLION_SIZE;
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
      uGridCount, vGridCount,
      height, baseY,
      frameMaterial, panelMaterial,
      footprint2D,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    const stroke = drawCtx.selected ? '#3a7bff' : '#7ec8e3';
    const points = facts.footprint2D.map(p => `${p.x},${p.y}`).join(' ');
    // Grid lines along wall axis at each u-grid column.
    const cellW = facts.length / facts.uGridCount;
    const ux = (facts.end.x - facts.start.x) / facts.length;
    const uy = (facts.end.y - facts.start.y) / facts.length;
    const nx = -uy, ny = ux;
    const hw = MULLION_SIZE / 2;
    const tickHw = Math.max(hw * 4, 0.04);
    const ticks: ReactNode[] = [];
    for (let i = 1; i < facts.uGridCount; i++) {
      const t = i * cellW;
      const cx = facts.start.x + ux * t;
      const cy = facts.start.y + uy * t;
      ticks.push(
        <line key={i}
          x1={cx + nx * tickHw} y1={cy + ny * tickHw}
          x2={cx - nx * tickHw} y2={cy - ny * tickHw}
          stroke={stroke} strokeWidth={0.015} />
      );
    }
    return (
      <g data-id={facts.id}>
        <polygon points={points} fill="#d6eaf8" stroke={stroke} strokeWidth={0.025} />
        {ticks}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const ux = (facts.end.x - facts.start.x) / facts.length;
    const uy = (facts.end.y - facts.start.y) / facts.length;
    const cellW = facts.length / facts.uGridCount;
    const cellH = facts.height / facts.vGridCount;
    const frameMat = getBimMaterial(resolveBimMaterial(facts.frameMaterial, 'curtain_wall'));
    const panelMat = getBimMaterial(resolveBimMaterial(facts.panelMaterial, 'curtain_wall'));
    const isHL = drawCtx.selected || drawCtx.hovered;
    const hlMat = isHL ? (
      <meshStandardMaterial attach="material" color="#06b6d4"
        transparent={frameMat.transparent} opacity={Math.max(frameMat.opacity, 0.4)} />
    ) : null;

    const meshes: ReactNode[] = [];

    // Vertical mullions at each u-grid line (0..uGridCount inclusive)
    for (let i = 0; i <= facts.uGridCount; i++) {
      const t = i * cellW;
      const worldX = facts.start.x + ux * t;
      const worldYSvg = facts.start.y + uy * t;
      const cy = facts.baseY + facts.height / 2;
      meshes.push(
        <mesh
          key={`vm${i}`}
          position={[worldX, cy, -worldYSvg]}
          rotation={[0, facts.angle, 0]}
          scale={[MULLION_SIZE, facts.height, MULLION_SIZE]}
          material={isHL ? undefined : frameMat}
          userData={{ elementId: facts.id }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {hlMat}
        </mesh>
      );
    }

    // Horizontal transoms at each v-grid line (full wall length)
    const handrailMidX = (facts.start.x + facts.end.x) / 2;
    const handrailMidYSvg = (facts.start.y + facts.end.y) / 2;
    for (let j = 0; j <= facts.vGridCount; j++) {
      const y = facts.baseY + j * cellH;
      meshes.push(
        <mesh
          key={`hm${j}`}
          position={[handrailMidX, y, -handrailMidYSvg]}
          rotation={[0, facts.angle, 0]}
          scale={[facts.length, MULLION_SIZE, MULLION_SIZE]}
          material={isHL ? undefined : frameMat}
          userData={{ elementId: facts.id }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {hlMat}
        </mesh>
      );
    }

    // Glass panels (one per cell)
    const pw = cellW - MULLION_SIZE;
    const ph = cellH - MULLION_SIZE;
    if (pw > 0.01 && ph > 0.01) {
      for (let i = 0; i < facts.uGridCount; i++) {
        for (let j = 0; j < facts.vGridCount; j++) {
          const tx = (i + 0.5) * cellW;
          const worldX = facts.start.x + ux * tx;
          const worldYSvg = facts.start.y + uy * tx;
          const cy = facts.baseY + (j + 0.5) * cellH;
          meshes.push(
            <mesh
              key={`p${i}_${j}`}
              position={[worldX, cy, -worldYSvg]}
              rotation={[0, facts.angle, 0]}
              scale={[pw, ph, PANEL_THICKNESS]}
              material={isHL ? undefined : panelMat}
              userData={{ elementId: facts.id }}
            >
              <boxGeometry args={[1, 1, 1]} />
              {hlMat}
            </mesh>
          );
        }
      }
    }

    return <group>{meshes}</group>;
  },
};

registerElement(curtainWallModule);
