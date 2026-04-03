import { memo, useMemo } from 'react';
import { BoxGeometry, BufferGeometry, Matrix4, type MeshPhysicalMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import { resolveHeight } from '../utils/elementTo3D.ts';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

interface CurtainWallExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const DEFAULT_WALL_HEIGHT = 3.0;
const MULLION_SIZE = 0.05; // mullion cross-section size in meters

interface CurtainWallMeshData {
  id: string;
  mullionGeo: BufferGeometry;
  panelGeo: BufferGeometry | null;
  mullionMat: MeshPhysicalMaterial;
  panelMat: MeshPhysicalMaterial;
}

/** Build merged mullion + panel geometries for a single curtain wall. */
function buildCurtainWallGeometry(
  wall: LineElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): { mullionGeo: BufferGeometry; panelGeo: BufferGeometry | null } | null {
  const { height, baseOffset } = resolveHeight(wall.attrs, levelElevation, levelElevations, DEFAULT_WALL_HEIGHT);
  const baseY = levelElevation + baseOffset;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const angle = Math.atan2(dy, dx);
  const cx = (wall.start.x + wall.end.x) / 2;
  const cy = (wall.start.y + wall.end.y) / 2;

  // Grid subdivision
  const uSpacing = parseFloat(wall.attrs.u_spacing) || 0;
  const vSpacing = parseFloat(wall.attrs.v_spacing) || 0;
  const uCount = uSpacing > 0 ? Math.max(1, Math.floor(len / uSpacing)) : Math.max(1, parseInt(wall.attrs.u_grid_count) || 3);
  const vCount = vSpacing > 0 ? Math.max(1, Math.floor(height / vSpacing)) : Math.max(1, parseInt(wall.attrs.v_grid_count) || 3);

  const cellW = len / uCount;
  const cellH = height / vCount;

  // All geometries are built in wall-local space then transformed:
  // Local: X along wall length (0..len), Y up (0..height), Z=0 (wall plane)
  // Then rotated by angle around Y and translated to world position.

  const mullions: BoxGeometry[] = [];
  const panels: BoxGeometry[] = [];

  // Vertical mullions (uCount+1 total, including edges)
  for (let i = 0; i <= uCount; i++) {
    const lx = i * cellW - len / 2; // local X relative to wall center
    const geo = new BoxGeometry(MULLION_SIZE, height, MULLION_SIZE);
    geo.translate(lx, height / 2, 0);
    mullions.push(geo);
  }

  // Horizontal mullions / transoms (vCount+1 total, including top/bottom)
  for (let j = 0; j <= vCount; j++) {
    const ly = j * cellH;
    const geo = new BoxGeometry(len, MULLION_SIZE, MULLION_SIZE);
    geo.translate(0, ly, 0);
    mullions.push(geo);
  }

  // Glass panels — thin boxes filling each cell
  const panelThickness = 0.006;
  for (let i = 0; i < uCount; i++) {
    for (let j = 0; j < vCount; j++) {
      const lx = (i + 0.5) * cellW - len / 2;
      const ly = (j + 0.5) * cellH;
      const pw = cellW - MULLION_SIZE;
      const ph = cellH - MULLION_SIZE;
      if (pw > 0.01 && ph > 0.01) {
        const geo = new BoxGeometry(pw, ph, panelThickness);
        geo.translate(lx, ly, 0);
        panels.push(geo);
      }
    }
  }

  // World transform: rotate around Y by wall angle, translate to wall center
  const worldMat = new Matrix4()
    .makeRotationY(angle)
    .setPosition(cx, baseY, -cy);

  // Merge mullions
  const mergedMullion = mergeGeometries(mullions, false);
  if (!mergedMullion) return null;
  mergedMullion.applyMatrix4(worldMat);
  for (const g of mullions) g.dispose();

  // Merge panels
  let mergedPanel: BufferGeometry | null = null;
  if (panels.length > 0) {
    mergedPanel = mergeGeometries(panels, false);
    if (mergedPanel) mergedPanel.applyMatrix4(worldMat);
    for (const g of panels) g.dispose();
  }

  return { mullionGeo: mergedMullion, panelGeo: mergedPanel };
}

/** Individual curtain wall mesh pair — re-renders on highlight change. */
const CurtainWallMesh = memo(function CurtainWallMesh({
  id, mullionGeo, panelGeo, mullionMat, panelMat, ghost, highlighted,
}: CurtainWallMeshData & { ghost?: boolean; highlighted: boolean }) {
  return (
    <group userData={{ elementId: id }}>
      <mesh
        geometry={mullionGeo}
        material={highlighted ? undefined : mullionMat}
        castShadow={!ghost}
        receiveShadow
        renderOrder={ghost ? -1 : 0}
        userData={{ elementId: id }}
        {...(ghost ? { raycast: () => {} } : {})}
      >
        {highlighted && (
          <meshStandardMaterial attach="material" color="#06b6d4" />
        )}
      </mesh>
      {panelGeo && (
        <mesh
          geometry={panelGeo}
          material={highlighted ? undefined : panelMat}
          castShadow={false}
          receiveShadow
          renderOrder={ghost ? -1 : 0}
          userData={{ elementId: id }}
          {...(ghost ? { raycast: () => {} } : {})}
        >
          {highlighted && (
            <meshStandardMaterial attach="material" color="#06b6d4"
              transparent opacity={0.4} />
          )}
        </mesh>
      )}
    </group>
  );
});

export default function CurtainWallExtrusions({
  elements, tableName, levelElevation, levelElevations, ghost,
}: CurtainWallExtrusionsProps) {
  const { selectedIds, hoveredId } = useSelectionState();

  const walls = useMemo(
    () => elements.filter((el): el is LineElement => el.geometry === 'line' || el.geometry === 'spatial_line'),
    [elements],
  );

  const meshes = useMemo(() => {
    const result: CurtainWallMeshData[] = [];
    for (const w of walls) {
      const built = buildCurtainWallGeometry(w, levelElevation, levelElevations);
      if (!built) continue;

      const frameMat = resolveBimMaterial(w.attrs.material, tableName);
      const panelMatName = resolveBimMaterial(w.attrs.panel_material, tableName);

      // Frame defaults to aluminum even if material attr says glass
      const mullionMat = ghost
        ? getGhostMaterial(frameMat === 'glass' ? 'aluminum' : frameMat)
        : getBimMaterial(frameMat === 'glass' ? 'aluminum' : frameMat);
      const panelMat = ghost ? getGhostMaterial(panelMatName) : getBimMaterial(panelMatName);

      result.push({
        id: w.id,
        mullionGeo: built.mullionGeo,
        panelGeo: built.panelGeo,
        mullionMat,
        panelMat,
      });
    }
    return result;
  }, [walls, tableName, levelElevation, levelElevations, ghost]);

  if (meshes.length === 0) return null;

  return (
    <group>
      {meshes.map(m => (
        <CurtainWallMesh
          key={m.id}
          {...m}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(m.id) || hoveredId === m.id)}
        />
      ))}
    </group>
  );
}
