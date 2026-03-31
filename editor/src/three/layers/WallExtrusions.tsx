import { memo, useMemo } from 'react';
import { Shape, ExtrudeGeometry, BoxGeometry, BufferGeometry, Matrix4, type MeshPhysicalMaterial } from 'three';
import { SUBTRACTION, Evaluator, Brush } from 'three-bvh-csg';
import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import { computeCornerAdjustments, type WallSegment } from '../../utils/wallMiter.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

interface WallExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
  allElements?: Map<string, CanonicalElement>;
}

const DEFAULT_WALL_HEIGHT = 3.0;
const csgEvaluator = new Evaluator();

interface WallMeshData {
  id: string;
  geometry: BufferGeometry;
  material: MeshPhysicalMaterial;
}

/** Point-to-line-segment distance. */
function pointToSegmentDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/** Build a map of wallId → hosted elements (doors/windows).
 *  Uses host_id when available, falls back to spatial proximity matching. */
function buildHostedMap(
  allElements: Map<string, CanonicalElement> | undefined,
  walls: LineElement[],
): Map<string, LineElement[]> {
  const map = new Map<string, LineElement[]>();
  if (!allElements) return map;

  // Collect all door/window line elements
  const openings: LineElement[] = [];
  for (const el of allElements.values()) {
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if (el.tableName !== 'door' && el.tableName !== 'window' && el.tableName !== 'opening') continue;
    openings.push(el as LineElement);
  }

  for (const op of openings) {
    const hostId = op.attrs.host_id;

    // 1) Try explicit host_id
    if (hostId && walls.some(w => w.id === hostId)) {
      const list = map.get(hostId) ?? [];
      list.push(op);
      map.set(hostId, list);
      continue;
    }

    // 2) Fall back to spatial matching: find the closest wall
    const cx = (op.start.x + op.end.x) / 2;
    const cy = (op.start.y + op.end.y) / 2;
    let bestWall: LineElement | null = null;
    let bestDist = Infinity;
    for (const w of walls) {
      const dist = pointToSegmentDist(cx, cy, w.start.x, w.start.y, w.end.x, w.end.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestWall = w;
      }
    }
    // Only match if within wall thickness
    if (bestWall && bestDist < bestWall.strokeWidth) {
      const list = map.get(bestWall.id) ?? [];
      list.push(op);
      map.set(bestWall.id, list);
    }
  }

  return map;
}

/** Subtract door/window openings from wall geometry using CSG. */
function subtractOpenings(
  wallGeo: BufferGeometry,
  wall: LineElement,
  hosted: LineElement[],
  levelElevation: number,
  _wallHeight: number,
  baseOffset: number,
): BufferGeometry {
  let wallBrush = new Brush(wallGeo);

  const wallDx = wall.end.x - wall.start.x;
  const wallDy = wall.end.y - wall.start.y;
  const wallLen = Math.sqrt(wallDx * wallDx + wallDy * wallDy);
  if (wallLen < 0.001) return wallGeo;

  for (const h of hosted) {
    const openingWidth = parseFloat(h.attrs.width) || 0.9;
    const openingHeight = parseFloat(h.attrs.height) || 2.1;
    const openingBaseOffset = parseFloat(h.attrs.base_offset) || 0;

    // Center of the hosted element in world coords
    const cx = (h.start.x + h.end.x) / 2;
    const cy = (h.start.y + h.end.y) / 2;

    // 3D position: x = worldX, y = baseY + openingBaseOffset + openingHeight/2, z = -worldY
    const baseY = levelElevation + baseOffset;
    const boxY = baseY + openingBaseOffset + openingHeight / 2;
    const boxX = cx;
    const boxZ = -cy;

    // Wall thickness * 2 to ensure full cut-through
    const thickness = wall.strokeWidth * 2;

    // Box aligned to wall direction
    const boxGeo = new BoxGeometry(openingWidth, openingHeight, thickness);
    const angle = -Math.atan2(wallDy, wallDx);
    const mat = new Matrix4()
      .makeRotationY(angle)
      .setPosition(boxX, boxY, boxZ);
    boxGeo.applyMatrix4(mat);

    const openingBrush = new Brush(boxGeo);

    try {
      const result = csgEvaluator.evaluate(wallBrush, openingBrush, SUBTRACTION);
      wallBrush = result;
    } catch {
      // CSG can fail on degenerate geometry — skip this opening
    }

    boxGeo.dispose();
  }

  return wallBrush.geometry;
}

/** Individual wall mesh — only re-renders when highlighted state changes. */
const WallMesh = memo(function WallMesh({
  id, geometry, material, ghost, highlighted,
}: WallMeshData & { ghost?: boolean; highlighted: boolean }) {
  return (
    <mesh
      geometry={geometry}
      material={highlighted ? undefined : material}
      castShadow={!ghost}
      receiveShadow
      renderOrder={ghost ? -1 : 0}
      userData={{ elementId: id }}
      {...(ghost ? { raycast: () => {} } : {})}
    >
      {highlighted && (
        <meshStandardMaterial attach="material" color="#06b6d4"
          transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
      )}
    </mesh>
  );
});

export default function WallExtrusions({ elements, tableName, levelElevation, levelElevations, ghost, allElements }: WallExtrusionsProps) {
  const { selectedIds, hoveredId } = useSelectionState();

  const walls = useMemo(() => elements.filter((el): el is LineElement => el.geometry === 'line' || el.geometry === 'spatial_line'), [elements]);
  const hostedMap = useMemo(() => buildHostedMap(allElements, walls), [allElements, walls]);

  const meshes = useMemo(() => {
    if (walls.length === 0) return [];

    const segments: WallSegment[] = walls.map(w => ({
      id: w.id,
      x1: w.start.x, y1: w.start.y,
      x2: w.end.x, y2: w.end.y,
      halfWidth: w.strokeWidth / 2,
      fill: '',
    }));

    const { adjustments: adj } = computeCornerAdjustments(segments);

    const result: WallMeshData[] = [];
    for (const w of walls) {
      const { height, baseOffset } = resolveHeight(w.attrs, levelElevation, levelElevations, DEFAULT_WALL_HEIGHT);
      const baseY = levelElevation + baseOffset;

      const hw = Math.max(w.strokeWidth, tableName === 'curtain_wall' ? 0.15 : 0) / 2;
      const dx = w.end.x - w.start.x;
      const dy = w.end.y - w.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) continue;
      const nx = -dy / len;
      const ny = dx / len;

      let p1x = w.start.x + nx * hw, p1y = w.start.y + ny * hw;
      let p2x = w.end.x + nx * hw, p2y = w.end.y + ny * hw;
      let p3x = w.end.x - nx * hw, p3y = w.end.y - ny * hw;
      let p4x = w.start.x - nx * hw, p4y = w.start.y - ny * hw;

      const startAdj = adj.get(`${w.id}:start`);
      if (startAdj) {
        p1x = startAdj.left.x;  p1y = startAdj.left.y;
        p4x = startAdj.right.x; p4y = startAdj.right.y;
      }
      const endAdj = adj.get(`${w.id}:end`);
      if (endAdj) {
        p2x = endAdj.right.x; p2y = endAdj.right.y;
        p3x = endAdj.left.x;  p3y = endAdj.left.y;
      }

      const shape = new Shape();
      shape.moveTo(p1x, p1y);
      shape.lineTo(p2x, p2y);
      shape.lineTo(p3x, p3y);
      shape.lineTo(p4x, p4y);
      shape.closePath();

      let geo: BufferGeometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, baseY, 0);

      // Subtract hosted door/window openings
      const hosted = hostedMap.get(w.id);
      if (hosted && hosted.length > 0 && !ghost) {
        geo = subtractOpenings(geo, w, hosted, levelElevation, height, baseOffset);
      }

      const bimMat = resolveBimMaterial(w.attrs.material, tableName);
      const mat = ghost ? getGhostMaterial(bimMat) : getBimMaterial(bimMat);

      result.push({ id: w.id, geometry: geo, material: mat });
    }
    return result;
  }, [elements, tableName, levelElevation, levelElevations, ghost, hostedMap]);

  if (meshes.length === 0) return null;

  return (
    <group>
      {meshes.map(({ id, geometry, material }) => (
        <WallMesh
          key={id}
          id={id}
          geometry={geometry}
          material={material}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(id) || hoveredId === id)}
        />
      ))}
    </group>
  );
}
