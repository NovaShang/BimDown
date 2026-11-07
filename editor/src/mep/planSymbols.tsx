/**
 * MEP plan symbols (model units, drawn inside the element's y-up frame):
 * terminals by type (diffuser X, sprinkler ⊕, receptacle, switch, fixtures),
 * equipment by type with a tag, inline accessories (valves, dampers) and the
 * small helpers they share (upright text, problem markers).
 *
 * The CLI renderer draws the same shapes (bimdown-spec/cli/src/render-mep.ts).
 */
import type { ReactNode } from 'react';
import type { ProblemMarker } from './mepView.ts';

type P = { x: number; y: number };

/** Text that reads left-to-right along `dir`, centred on (x, y). */
export function PlanText({ x, y, dir, size, color, text, weight = 500 }: {
  x: number; y: number; dir?: P; size: number; color: string; text: string; weight?: number;
}) {
  let ang = dir ? (Math.atan2(dir.y, dir.x) * 180) / Math.PI : 0;
  if (ang > 90.01) ang -= 180;
  if (ang < -89.99) ang += 180;
  return (
    <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize={size}
      fontFamily="Inter, sans-serif" fontWeight={weight} fill={color} pointerEvents="none"
      transform={`translate(${x},${y}) rotate(${ang}) scale(1,-1)`}>
      {text}
    </text>
  );
}

export function ProblemMarkers({ points }: { points: readonly ProblemMarker[] }) {
  return (
    <g pointerEvents="none">
      {points.map((p, i) => {
        const c = p.severity === 'warning' ? '#ef4444' : '#f59e0b';
        return (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={0.22} fill={c} fillOpacity={0.18} stroke={c} strokeWidth={0.035} />
            <PlanText x={p.x} y={p.y} size={0.24} color={c} text="!" weight={800} />
          </g>
        );
      })}
    </g>
  );
}

const line = (a: P, b: P, k: string | number, stroke: string, sw: number) =>
  <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={sw} />;

/**
 * Terminal symbol in its local frame (origin = terminal, x along its
 * rotation), footprint w × d. Returns null for unknown types (caller draws
 * the plain footprint).
 */
export function terminalSymbol(type: string, w: number, d: number, stroke: string, fill: string): ReactNode {
  const hw = w / 2, hd = d / 2;
  const sw = Math.max(0.012, Math.min(w, d) * 0.04);
  const rect = (k: string, x0 = -hw, y0 = -hd, ww = w, dd = d, rx = 0) =>
    <rect key={k} x={x0} y={y0} width={ww} height={dd} rx={rx} fill={fill} stroke={stroke} strokeWidth={sw} />;
  const r = Math.min(hw, hd);
  switch (type) {
    case 'supply_air_diffuser':
      return [rect('o'), rect('i', -hw * 0.55, -hd * 0.55, w * 0.55, d * 0.55),
        line({ x: -hw, y: -hd }, { x: hw, y: hd }, 'd1', stroke, sw), line({ x: -hw, y: hd }, { x: hw, y: -hd }, 'd2', stroke, sw)];
    case 'return_air_grille':
      return [rect('o'), line({ x: -hw, y: -hd }, { x: hw, y: hd }, 'd1', stroke, sw)];
    case 'exhaust_air_grille':
      return [rect('o'), line({ x: -hw, y: hd }, { x: hw, y: -hd }, 'd1', stroke, sw),
        line({ x: -hw, y: 0 }, { x: 0, y: -hd }, 'd2', stroke, sw), line({ x: 0, y: hd }, { x: hw, y: 0 }, 'd3', stroke, sw)];
    case 'sprinkler_head': {
      const rr = Math.max(r, 0.06);
      return [<circle key="c" cx={0} cy={0} r={rr} fill={fill} stroke={stroke} strokeWidth={sw} />,
        line({ x: -rr * 1.5, y: 0 }, { x: rr * 1.5, y: 0 }, 'h', stroke, sw), line({ x: 0, y: -rr * 1.5 }, { x: 0, y: rr * 1.5 }, 'v', stroke, sw),
        <circle key="d" cx={0} cy={0} r={rr * 0.35} fill={stroke} />];
    }
    case 'light_fixture':
      if (Math.abs(w - d) < 1e-3 && w <= 0.35) {
        return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
          line({ x: -r * 0.7, y: -r * 0.7 }, { x: r * 0.7, y: r * 0.7 }, 'd1', stroke, sw), line({ x: -r * 0.7, y: r * 0.7 }, { x: r * 0.7, y: -r * 0.7 }, 'd2', stroke, sw)];
      }
      return [rect('o'), line({ x: -hw, y: -hd }, { x: hw, y: hd }, 'd1', stroke, sw), line({ x: -hw, y: hd }, { x: hw, y: -hd }, 'd2', stroke, sw)];
    case 'emergency_light':
      return [rect('o'), <polygon key="t" points={`${-hw},${-hd} ${hw},${-hd} ${hw},${hd}`} fill={stroke} />];
    case 'power_outlet':
      return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
        line({ x: -r * 0.5, y: -r * 0.9 }, { x: -r * 0.5, y: r * 0.9 }, 'l1', stroke, sw), line({ x: r * 0.5, y: -r * 0.9 }, { x: r * 0.5, y: r * 0.9 }, 'l2', stroke, sw)];
    case 'data_outlet':
      return [<polygon key="t" points={`${-hw},${-hd} ${hw},${-hd} 0,${hd}`} fill={fill} stroke={stroke} strokeWidth={sw} />];
    case 'switch':
      return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
        <PlanText key="s" x={0} y={0} size={r * 1.3} color={stroke} text="S" weight={700} />];
    case 'junction_box':
      return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
        <PlanText key="s" x={0} y={0} size={r * 1.2} color={stroke} text="J" weight={700} />];
    case 'fire_alarm_device':
      return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
        <PlanText key="s" x={0} y={0} size={r * 0.9} color={stroke} text="FA" weight={700} />];
    case 'water_closet':
      // Tank at the back (−y), elongated bowl to the front.
      return [rect('t', -hw, -hd, w, d * 0.28, 0.02),
        <ellipse key="b" cx={0} cy={d * 0.12} rx={hw * 0.8} ry={d * 0.36} fill={fill} stroke={stroke} strokeWidth={sw} />];
    case 'urinal':
      return [<path key="u" d={`M ${-hw},${-hd} L ${hw},${-hd} L ${hw},${hd * 0.2} A ${hw},${hd * 0.8} 0 0 1 ${-hw},${hd * 0.2} Z`} fill={fill} stroke={stroke} strokeWidth={sw} />];
    case 'lavatory':
      return [rect('o', -hw, -hd, w, d, 0.03), <ellipse key="b" cx={0} cy={d * 0.05} rx={hw * 0.7} ry={hd * 0.6} fill="none" stroke={stroke} strokeWidth={sw} />];
    case 'sink':
      return [rect('o'), rect('i', -hw * 0.8, -hd * 0.7, w * 0.8, d * 0.75, 0.03)];
    case 'shower':
      return [rect('o'), line({ x: -hw, y: -hd }, { x: hw, y: hd }, 'd1', stroke, sw * 0.7), line({ x: -hw, y: hd }, { x: hw, y: -hd }, 'd2', stroke, sw * 0.7),
        <circle key="dr" cx={0} cy={0} r={Math.min(hw, hd) * 0.12} fill={fill} stroke={stroke} strokeWidth={sw} />];
    case 'floor_drain':
      return [<circle key="c" cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />,
        line({ x: -r * 0.6, y: -r * 0.3 }, { x: r * 0.6, y: -r * 0.3 }, 'g1', stroke, sw * 0.7), line({ x: -r * 0.6, y: r * 0.3 }, { x: r * 0.6, y: r * 0.3 }, 'g2', stroke, sw * 0.7),
        line({ x: -r * 0.3, y: -r * 0.6 }, { x: -r * 0.3, y: r * 0.6 }, 'g3', stroke, sw * 0.7), line({ x: r * 0.3, y: -r * 0.6 }, { x: r * 0.3, y: r * 0.6 }, 'g4', stroke, sw * 0.7)];
    case 'plumbing_fixture':
      return [rect('o', -hw, -hd, w, d, Math.min(hw, hd) * 0.4)];
    default:
      return null;
  }
}

const EQUIPMENT_ABBR: Record<string, string> = {
  ahu: 'AHU', fcu: 'FCU', vav: 'VAV', chiller: 'CH', boiler: 'B', cooling_tower: 'CT', fan: 'F', pump: 'P', coil: 'C',
  transformer: 'TX', panelboard: 'PNL', generator: 'GEN', water_heater: 'WH', tank: 'T', other: 'EQ',
};

export function equipmentAbbr(type: string): string {
  return EQUIPMENT_ABBR[type] ?? 'EQ';
}

/** Equipment symbol in its local frame: footprint + type graphic. The tag is drawn by the caller. */
export function equipmentSymbol(type: string, w: number, d: number, stroke: string, fill: string): ReactNode {
  const hw = w / 2, hd = d / 2;
  const sw = Math.max(0.015, Math.min(0.03, Math.min(w, d) * 0.03));
  const out: ReactNode[] = [<rect key="o" x={-hw} y={-hd} width={w} height={d} rx={Math.min(0.05, Math.min(hw, hd) * 0.2)} fill={fill} stroke={stroke} strokeWidth={sw} />];
  const r = Math.min(hw, hd) * 0.6;
  switch (type) {
    case 'pump':
      out.push(<circle key="c" cx={0} cy={0} r={r} fill="none" stroke={stroke} strokeWidth={sw} />,
        <polygon key="t" points={`${-r * 0.5},${-r * 0.6} ${-r * 0.5},${r * 0.6} ${r * 0.7},0`} fill={stroke} fillOpacity={0.6} />);
      break;
    case 'fan':
      out.push(<circle key="c" cx={0} cy={0} r={r} fill="none" stroke={stroke} strokeWidth={sw} />);
      for (let i = 0; i < 3; i++) {
        const a = (i * 2 * Math.PI) / 3;
        out.push(<ellipse key={`b${i}`} cx={Math.cos(a) * r * 0.45} cy={Math.sin(a) * r * 0.45} rx={r * 0.45} ry={r * 0.16}
          transform={`rotate(${(a * 180) / Math.PI} ${Math.cos(a) * r * 0.45} ${Math.sin(a) * r * 0.45})`} fill={stroke} fillOpacity={0.5} />);
      }
      break;
    case 'panelboard':
      out.push(<polygon key="h" points={`${-hw},${-hd} ${hw},${-hd} ${hw},${hd}`} fill={stroke} fillOpacity={0.55} />);
      break;
    case 'transformer':
      out.push(<circle key="c1" cx={-r * 0.45} cy={0} r={r * 0.6} fill="none" stroke={stroke} strokeWidth={sw} />,
        <circle key="c2" cx={r * 0.45} cy={0} r={r * 0.6} fill="none" stroke={stroke} strokeWidth={sw} />);
      break;
    case 'cooling_tower':
      out.push(<circle key="c" cx={0} cy={0} r={r} fill="none" stroke={stroke} strokeWidth={sw} />,
        line({ x: -r, y: 0 }, { x: r, y: 0 }, 'h', stroke, sw), line({ x: 0, y: -r }, { x: 0, y: r }, 'v', stroke, sw));
      break;
    case 'water_heater':
    case 'tank':
      out.push(<circle key="c" cx={0} cy={0} r={Math.min(hw, hd) * 0.92} fill="none" stroke={stroke} strokeWidth={sw} />);
      break;
    case 'vav':
      out.push(line({ x: -hw, y: -hd }, { x: hw, y: hd }, 'd', stroke, sw));
      break;
    default:
      break;
  }
  return out;
}

/**
 * Inline accessory symbol along +x (the run direction), centred on the node:
 * body length `L`, height `H` (the run's plan width or a bit more).
 */
export function accessorySymbol(kind: string, L: number, H: number, stroke: string, fill: string): ReactNode {
  const hl = L / 2, hh = H / 2;
  const sw = Math.max(0.012, Math.min(0.025, H * 0.06));
  const bowtie = (k: string, filledLeft = false, filledRight = false) => [
    <polygon key={`${k}l`} points={`${-hl},${-hh} ${-hl},${hh} 0,0`} fill={filledLeft ? stroke : fill} stroke={stroke} strokeWidth={sw} />,
    <polygon key={`${k}r`} points={`${hl},${-hh} ${hl},${hh} 0,0`} fill={filledRight ? stroke : fill} stroke={stroke} strokeWidth={sw} />,
  ];
  switch (kind) {
    case 'valve':
    case 'gate_valve':
      return bowtie('g');
    case 'ball_valve':
      return [...bowtie('b'), <circle key="c" cx={0} cy={0} r={hh * 0.45} fill={stroke} />];
    case 'globe_valve':
      return [...bowtie('gl'), <circle key="c" cx={0} cy={0} r={hh * 0.45} fill={fill} stroke={stroke} strokeWidth={sw} />];
    case 'butterfly_valve':
      return [...bowtie('bf'), line({ x: 0, y: -hh * 1.2 }, { x: 0, y: hh * 1.2 }, 'bar', stroke, sw * 1.4)];
    case 'balancing_valve':
      return [...bowtie('bv'), line({ x: -hl * 0.8, y: -hh * 1.1 }, { x: hl * 0.8, y: hh * 1.1 }, 'ar', stroke, sw),
        <polygon key="ah" points={`${hl * 0.8},${hh * 1.1} ${hl * 0.45},${hh * 1.05} ${hl * 0.7},${hh * 0.75}`} fill={stroke} />];
    case 'check_valve':
      return [<polygon key="t" points={`${-hl},${-hh} ${-hl},${hh} ${hl * 0.6},0`} fill={stroke} fillOpacity={0.75} stroke={stroke} strokeWidth={sw} />,
        line({ x: hl * 0.6, y: -hh }, { x: hl * 0.6, y: hh }, 'bar', stroke, sw * 1.4)];
    case 'strainer':
      return [line({ x: -hl, y: 0 }, { x: hl, y: 0 }, 'l', stroke, sw), line({ x: -hl * 0.3, y: 0 }, { x: hl * 0.5, y: -hh }, 'y', stroke, sw),
        line({ x: hl * 0.2, y: -hh * 1.1 }, { x: hl * 0.8, y: -hh * 0.9 }, 'c', stroke, sw)];
    case 'damper':
      return [<rect key="b" x={-hl} y={-hh} width={L} height={H} fill={fill} stroke={stroke} strokeWidth={sw} />,
        line({ x: -hl * 0.6, y: -hh * 0.85 }, { x: hl * 0.6, y: hh * 0.85 }, 'blade', stroke, sw * 1.3),
        <circle key="p" cx={0} cy={0} r={Math.min(hl, hh) * 0.18} fill={stroke} />];
    case 'fire_damper':
      return [<rect key="b" x={-hl} y={-hh} width={L} height={H} fill={fill} stroke={stroke} strokeWidth={sw} />,
        line({ x: -hl, y: -hh }, { x: hl, y: hh }, 'd1', stroke, sw), line({ x: -hl, y: hh }, { x: hl, y: -hh }, 'd2', stroke, sw),
        <PlanText key="t" x={0} y={hh + Math.max(0.12, H * 0.25)} size={Math.max(0.12, Math.min(0.2, H * 0.35))} color={stroke} text="FD" weight={700} />];
    case 'flow_meter':
      return [<circle key="c" cx={0} cy={0} r={Math.max(hh, hl * 0.7)} fill={fill} stroke={stroke} strokeWidth={sw} />,
        <PlanText key="t" x={0} y={0} size={Math.max(hh, hl * 0.7)} color={stroke} text="M" weight={700} />];
    case 'pump':
      return [<circle key="c" cx={0} cy={0} r={Math.max(hh, hl * 0.8)} fill={fill} stroke={stroke} strokeWidth={sw} />,
        <polygon key="t" points={`${-hl * 0.4},${-hh * 0.6} ${-hl * 0.4},${hh * 0.6} ${hl * 0.6},0`} fill={stroke} />];
    case 'sensor':
      return [<circle key="c" cx={0} cy={0} r={Math.max(hh * 0.7, 0.05)} fill={fill} stroke={stroke} strokeWidth={sw} />];
    default:
      return [<rect key="b" x={-hl} y={-hh} width={L} height={H} rx={Math.min(hl, hh) * 0.3} fill={fill} stroke={stroke} strokeWidth={sw} />];
  }
}
