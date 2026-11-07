/**
 * Equipment and terminal views: plan symbol by type with a tag, simple 3D
 * bodies by type (cylinders for tanks / heaters / pumps, plates for
 * diffusers and lights, boxes otherwise).
 */
import { useMemo } from 'react';
import { BoxGeometry, CylinderGeometry, type BufferGeometry } from 'three';
import { getBimMaterial, resolveBimMaterial } from '../three/utils/bimMaterials.ts';
import { useMepView, isolateOpacity, inSystem } from './mepView.ts';
import { equipmentAbbr, equipmentSymbol, terminalSymbol, PlanText, ProblemMarkers } from './planSymbols.tsx';
import { ghostMaterial, solidMaterial } from './materials.ts';

export interface DeviceFacts {
  id: string;
  table: string;
  position: { x: number; y: number };
  width: number;
  depth: number;
  height: number;
  rotationDeg: number;
  baseY: number;
  material: string;
  color: string;
  /** equipment_type / terminal_type. */
  type: string;
  number: string;
  systemType: string;
  /** Resolved system colour (first system), or '' when untagged. */
  systemColor: string;
  flow: number;
  load: number;
  circuit: string;
}

const TERMINAL_COLOR_BY_TYPE: Record<string, string> = {
  light_fixture: '#c99a06', emergency_light: '#c99a06', power_outlet: '#a16207', switch: '#a16207',
  junction_box: '#a16207', data_outlet: '#15803d', fire_alarm_device: '#dc2626', sprinkler_head: '#dc2626',
};

export function deviceStroke(f: DeviceFacts): string {
  return f.systemColor || TERMINAL_COLOR_BY_TYPE[f.type] || f.color;
}

export function Device2D({ facts, selected }: { facts: DeviceFacts; selected: boolean }) {
  const view = useMepView();
  const stroke = selected ? '#3a7bff' : deviceStroke(facts);
  const fill = stroke + '26';
  const sym = facts.table === 'equipment'
    ? equipmentSymbol(facts.type, facts.width, facts.depth, stroke, fill)
    : terminalSymbol(facts.type, facts.width, facts.depth, stroke, fill);
  const markers = view.showProblems ? view.problemMarkers.get(facts.id) : undefined;
  const highlighted = (!!view.highlight && inSystem(facts.systemType, view.highlight)) || (!!view.circuit && view.circuit === facts.circuit);
  const tag = facts.table === 'equipment'
    ? (facts.number || equipmentAbbr(facts.type))
    : facts.flow > 0 && /diffuser|grille/.test(facts.type) ? `${Math.round(facts.flow)} L/s` : '';
  const tagSize = facts.table === 'equipment' ? Math.max(0.14, Math.min(0.3, Math.min(facts.width, facts.depth) * 0.3)) : 0.12;
  const tagY = facts.table === 'equipment' ? facts.position.y : facts.position.y - facts.depth / 2 - 0.12;
  return (
    <g data-id={facts.id} opacity={isolateOpacity(view, facts.systemType)}>
      {highlighted && (
        <circle cx={facts.position.x} cy={facts.position.y} r={Math.max(facts.width, facts.depth) * 0.75 + 0.1}
          fill="none" stroke={stroke} strokeWidth={0.08} strokeOpacity={0.35} />
      )}
      <g transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`} data-id={facts.id}>
        {sym ?? (
          <rect x={-facts.width / 2} y={-facts.depth / 2} width={facts.width} height={facts.depth}
            fill={fill} stroke={stroke} strokeWidth={0.02} rx={0.03} ry={0.03} />
        )}
        <rect x={-facts.width / 2} y={-facts.depth / 2} width={facts.width} height={facts.depth} fill="transparent" data-id={facts.id} />
      </g>
      {view.showTags && tag && (
        <PlanText x={facts.position.x} y={tagY} size={tagSize} color={stroke} text={tag} weight={600} />
      )}
      {markers && <ProblemMarkers points={markers} />}
    </g>
  );
}

const CYLINDER_TYPES = new Set(['water_heater', 'tank']);
const PLATE_TYPES = /diffuser|grille|light|sprinkler|fire_alarm|floor_drain|emergency/;

function deviceGeometry(f: DeviceFacts): { geo: BufferGeometry; y: number }[] {
  const { width: w, depth: d, height: h } = f;
  if (f.table === 'equipment' && CYLINDER_TYPES.has(f.type)) {
    const r = Math.min(w, d) / 2;
    return [{ geo: new CylinderGeometry(r, r, h, 24), y: h / 2 }];
  }
  if (f.table === 'equipment' && f.type === 'pump') {
    const r = Math.min(d, h) * 0.4;
    return [
      { geo: new BoxGeometry(w, h * 0.15, d), y: h * 0.075 },
      { geo: new CylinderGeometry(r, r, w * 0.7, 20).rotateZ(Math.PI / 2), y: h * 0.15 + r },
    ];
  }
  if (f.table === 'equipment' && f.type === 'cooling_tower') {
    const r = Math.min(w, d) * 0.35;
    return [
      { geo: new BoxGeometry(w, h * 0.85, d), y: h * 0.425 },
      { geo: new CylinderGeometry(r, r, h * 0.15, 24), y: h * 0.925 },
    ];
  }
  if (f.table === 'terminal' && f.type === 'sprinkler_head') {
    const r = Math.max(Math.min(w, d) / 2, 0.03);
    return [{ geo: new CylinderGeometry(r * 0.25, r, h, 12), y: h / 2 }];
  }
  if (f.table === 'terminal' && PLATE_TYPES.test(f.type)) {
    const t = Math.min(h, 0.06);
    return [{ geo: new BoxGeometry(w, t, d), y: t / 2 }, ...(h > t ? [{ geo: new BoxGeometry(w * 0.5, h - t, d * 0.5), y: t + (h - t) / 2 }] : [])];
  }
  return [{ geo: new BoxGeometry(w, h, d), y: h / 2 }];
}

export function Device3D({ facts, isHL }: { facts: DeviceFacts; isHL: boolean }) {
  const view = useMepView();
  const parts = useMemo(() => deviceGeometry(facts), [facts.table, facts.type, facts.width, facts.depth, facts.height]);
  const ghost = isolateOpacity(view, facts.systemType) < 1;
  const material = ghost
    ? ghostMaterial(deviceStroke(facts))
    : facts.material
      ? getBimMaterial(resolveBimMaterial(facts.material, facts.table))
      : facts.table === 'terminal'
        ? solidMaterial(facts.type.includes('light') ? '#f5f1dc' : '#e5e7eb', 0.1)
        : getBimMaterial(resolveBimMaterial('', facts.table));
  // three.js rotation.y = θ turns plan +X to (cos θ, sin θ): spec rotation is CCW.
  const rotY = (facts.rotationDeg * Math.PI) / 180;
  return (
    <group position={[facts.position.x, facts.baseY, -facts.position.y]} rotation={[0, rotY, 0]} userData={{ elementId: facts.id }}>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geo} position={[0, p.y, 0]} material={isHL ? undefined : material} userData={{ elementId: facts.id }}>
          {isHL && <meshStandardMaterial attach="material" color="#06b6d4" />}
        </mesh>
      ))}
    </group>
  );
}
