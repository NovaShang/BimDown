import { useMemo } from 'react';
import { SphereGeometry, MeshBasicMaterial } from 'three';
import { Line, Html } from '@react-three/drei';
import { useEditorState } from '../../state/EditorContext.tsx';
import { resolveLineStrokeWidth } from '../../utils/geometry.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';
import { createExtrudeGeometry } from '../utils/extrudePolygon.ts';
import type { Point } from '../../model/elements.ts';

// ─── Shared geometries & materials ───────────────────────────────────────────
const SPHERE_GEO_LG = new SphereGeometry(0.15, 8, 8);
const SPHERE_GEO_MD = new SphereGeometry(0.12, 8, 8);
const SPHERE_GEO_SM = new SphereGeometry(0.1, 8, 8);
const SPHERE_GEO_XS = new SphereGeometry(0.08, 8, 8);
const DOT_MATERIAL = new MeshBasicMaterial({ color: '#4fc3f7' });
const DOT_MATERIAL_FADED = new MeshBasicMaterial({ color: '#4fc3f7', transparent: true, opacity: 0.6 });

// Preview materials: fill + wireframe overlay
const PREVIEW_FILL = new MeshBasicMaterial({ color: '#4fc3f7', transparent: true, opacity: 0.15, depthWrite: false });
const PREVIEW_WIREFRAME = new MeshBasicMaterial({ color: '#4fc3f7', transparent: true, opacity: 0.4, wireframe: true });

// ─── Height fallback defaults (matching elementTo3D.ts) ─────────────────────
const DEFAULT_WALL_HEIGHT = 3.0;
const DEFAULT_COLUMN_HEIGHT = 3.0;
const DEFAULT_POINT_HEIGHT = 0.5;
const DEFAULT_SLAB_THICKNESS = 0.2;
const DEFAULT_MEP_SIZE = 0.3;

function resolveHeightFallback(tableName: string, attrs: Record<string, string>): number {
  if (['wall', 'structure_wall', 'curtain_wall'].includes(tableName)) return DEFAULT_WALL_HEIGHT;
  if (['column', 'structure_column'].includes(tableName)) return DEFAULT_COLUMN_HEIGHT;
  if (tableName === 'door') return parseFloat(attrs.height) || 2.1;
  if (tableName === 'window') return parseFloat(attrs.height) || 1.2;
  if (['duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace'].includes(tableName)) return DEFAULT_MEP_SIZE;
  if (['slab', 'structure_slab'].includes(tableName)) return parseFloat(attrs.thickness) || DEFAULT_SLAB_THICKNESS;
  if (['equipment', 'terminal'].includes(tableName)) return DEFAULT_POINT_HEIGHT;
  return DEFAULT_WALL_HEIGHT;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLength(meters: number): string {
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

function LengthLabel3D({ from, to, elevation }: { from: Point; to: Point; elevation: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.3;

  return (
    <Html
      position={[mx + nx * offset, elevation + 0.15, -(my + ny * offset)]}
      style={{
        color: '#4fc3f7',
        fontSize: '11px',
        fontFamily: 'monospace',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        textShadow: '0 0 3px rgba(0,0,0,0.5)',
      }}
      center
    >
      {formatLength(len)}
    </Html>
  );
}

/** Convert model (x, y) to 3D position at given elevation. */
function toWorld(x: number, y: number, elev: number): [number, number, number] {
  return [x, elev + 0.05, -y]; // slightly above floor to avoid z-fighting
}

/** 3D box preview (semi-transparent fill + wireframe outline). */
function BoxPreview({ position, rotation, args }: {
  position: [number, number, number];
  rotation: [number, number, number];
  args: [number, number, number];
}) {
  return (
    <group position={position} rotation={rotation}>
      <mesh material={PREVIEW_FILL}>
        <boxGeometry args={args} />
      </mesh>
      <mesh material={PREVIEW_WIREFRAME}>
        <boxGeometry args={args} />
      </mesh>
    </group>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

interface DrawingOverlay3DProps {
  elevation: number;
}

export default function DrawingOverlay3D({ elevation }: DrawingOverlay3DProps) {
  const { drawingState, activeTool, drawingAttrs, drawingTarget, project } = useEditorState();

  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    if (project) for (const l of project.levels) map.set(l.id, l.elevation);
    return map;
  }, [project]);

  if (!drawingState) return null;

  const { points, cursor } = drawingState;
  const tableName = drawingTarget?.tableName ?? null;

  // ─── Line preview (draw_line & draw_hosted) ────────────────────────────────
  if (activeTool === 'draw_line' || activeTool === 'draw_hosted') {
    if (points.length === 1 && cursor) {
      const thickness = tableName ? (resolveLineStrokeWidth(tableName, drawingAttrs) ?? 0) : 0;

      // Compute 3D box preview params
      const dx = cursor.x - points[0].x;
      const dy = cursor.y - points[0].y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const fallbackH = tableName ? resolveHeightFallback(tableName, drawingAttrs) : DEFAULT_WALL_HEIGHT;
      const { height, baseOffset } = resolveHeight(drawingAttrs, elevation, levelElevations, fallbackH);
      const baseY = elevation + baseOffset;
      const cx = (points[0].x + cursor.x) / 2;
      const cz = -(points[0].y + cursor.y) / 2;
      const cy = baseY + height / 2;
      const rotY = Math.atan2(dy, dx);

      return (
        <group>
          {/* 3D volume preview */}
          {length > 0.001 && thickness > 0 && (
            <BoxPreview
              position={[cx, cy, cz]}
              rotation={[0, rotY, 0]}
              args={[length, height, thickness]}
            />
          )}
          {/* Center line (dashed) */}
          <Line
            points={[toWorld(points[0].x, points[0].y, elevation), toWorld(cursor.x, cursor.y, elevation)]}
            color="#4fc3f7"
            lineWidth={2}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          {/* Start dot */}
          <mesh position={toWorld(points[0].x, points[0].y, elevation)} geometry={SPHERE_GEO_LG} material={DOT_MATERIAL} />
          {/* Cursor dot */}
          <mesh position={toWorld(cursor.x, cursor.y, elevation)} geometry={SPHERE_GEO_SM} material={DOT_MATERIAL_FADED} />
          <LengthLabel3D from={points[0]} to={cursor} elevation={elevation} />
        </group>
      );
    }

    // draw_hosted: cursor-only mode (no points yet) — show cursor dot
    if (activeTool === 'draw_hosted' && points.length === 0 && cursor) {
      return (
        <group>
          <mesh position={toWorld(cursor.x, cursor.y, elevation)} geometry={SPHERE_GEO_SM} material={DOT_MATERIAL_FADED} />
        </group>
      );
    }

    return null;
  }

  // ─── Point preview (draw_point) ────────────────────────────────────────────
  if (activeTool === 'draw_point') {
    if (cursor) {
      const w = parseFloat(drawingAttrs.size_x || '0.3');
      const d = parseFloat(drawingAttrs.size_y || '0.3');
      const fallbackH = tableName ? resolveHeightFallback(tableName, drawingAttrs) : DEFAULT_POINT_HEIGHT;
      const { height, baseOffset } = resolveHeight(drawingAttrs, elevation, levelElevations, fallbackH);
      const baseY = elevation + baseOffset;
      const cy = baseY + height / 2;

      return (
        <group>
          {/* 3D volume preview */}
          <BoxPreview
            position={[cursor.x, cy, -cursor.y]}
            rotation={[0, 0, 0]}
            args={[w, height, d]}
          />
          {/* Crosshair lines on floor */}
          <Line
            points={[
              [cursor.x - w, elevation + 0.05, -cursor.y],
              [cursor.x + w, elevation + 0.05, -cursor.y],
            ]}
            color="#4fc3f7"
            lineWidth={1}
            opacity={0.5}
            transparent
          />
          <Line
            points={[
              [cursor.x, elevation + 0.05, -cursor.y - d],
              [cursor.x, elevation + 0.05, -cursor.y + d],
            ]}
            color="#4fc3f7"
            lineWidth={1}
            opacity={0.5}
            transparent
          />
        </group>
      );
    }
    return null;
  }

  // ─── Polygon preview (draw_polygon) ────────────────────────────────────────
  if (activeTool === 'draw_polygon') {
    if (points.length === 0 && !cursor) return null;

    const allPts = cursor ? [...points, cursor] : points;

    // Compute extrusion parameters for 3D preview
    const fallbackH = tableName ? resolveHeightFallback(tableName, drawingAttrs) : DEFAULT_SLAB_THICKNESS;
    const baseOffset = parseFloat(drawingAttrs.base_offset) || 0;
    const baseY = elevation + baseOffset;
    let extrudeHeight = fallbackH;
    if (['slab', 'structure_slab'].includes(tableName ?? '')) {
      extrudeHeight = parseFloat(drawingAttrs.thickness) || DEFAULT_SLAB_THICKNESS;
    } else {
      const resolved = resolveHeight(drawingAttrs, elevation, levelElevations, fallbackH);
      extrudeHeight = resolved.height;
    }

    return (
      <group>
        {/* 3D extrusion preview (when ≥ 3 vertices) */}
        {allPts.length >= 3 && (
          <ExtrudePreview vertices={allPts} baseY={baseY} height={extrudeHeight} />
        )}
        {/* Lines between placed points */}
        {points.map((p, i) => {
          const next = i < points.length - 1 ? points[i + 1] : cursor;
          if (!next) return null;
          return (
            <Line
              key={i}
              points={[toWorld(p.x, p.y, elevation), toWorld(next.x, next.y, elevation)]}
              color="#4fc3f7"
              lineWidth={2}
            />
          );
        })}
        {/* Closing line preview */}
        {cursor && points.length >= 2 && (
          <Line
            points={[
              toWorld(allPts[allPts.length - 1].x, allPts[allPts.length - 1].y, elevation),
              toWorld(points[0].x, points[0].y, elevation),
            ]}
            color="#4fc3f7"
            lineWidth={1}
            dashed
            dashSize={0.2}
            gapSize={0.15}
            opacity={0.5}
            transparent
          />
        )}
        {/* Vertex dots */}
        {points.map((p, i) => (
          <mesh key={i} position={toWorld(p.x, p.y, elevation)} geometry={SPHERE_GEO_MD} material={DOT_MATERIAL} />
        ))}
        {/* Cursor dot */}
        {cursor && (
          <mesh position={toWorld(cursor.x, cursor.y, elevation)} geometry={SPHERE_GEO_XS} material={DOT_MATERIAL_FADED} />
        )}
      </group>
    );
  }

  return null;
}

/** Polygon extrusion preview using createExtrudeGeometry. */
function ExtrudePreview({ vertices, baseY, height }: { vertices: Point[]; baseY: number; height: number }) {
  const geometry = useMemo(
    () => createExtrudeGeometry({ kind: 'extrude', vertices, baseY, height }),
    [vertices, baseY, height],
  );

  if (!geometry) return null;

  return (
    <>
      <mesh geometry={geometry} material={PREVIEW_FILL} />
      <mesh geometry={geometry} material={PREVIEW_WIREFRAME} />
    </>
  );
}
