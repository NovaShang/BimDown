/**
 * Doors and windows in the plan canvas, drafted like the plan export
 * (export/drawing/plan.ts) and Revit: black line work on the zoom-scaled pens
 * (planDetail.ts) — a door leaf with its swing arc, a window as the wall's two
 * faces and jambs across the opening with the glass lines between them.
 */
import type { ReactNode } from 'react';
import type { Point } from '../model/elements.ts';

const INK = '#1a1a2e';
const SELECTED = '#3a7bff';

const add = (p: Point, v: Point, t = 1): Point => ({ x: p.x + v.x * t, y: p.y + v.y * t });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: Point): Point => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const perp = (v: Point): Point => ({ x: -v.y, y: v.x });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const pts = (ps: Point[]) => ps.map(p => `${p.x},${p.y}`).join(' ');

export interface OpeningPlanInput {
  start: Point;
  end: Point;
  /** Host wall thickness. */
  thickness: number;
}

export interface DoorPlanInput extends OpeningPlanInput {
  operation: string;
  hingeEnd: boolean;
  swingRight: boolean;
}

/** Arc from a to b around c (radius |a − c|), as an SVG path. */
function arcPath(c: Point, a: Point, b: Point): string {
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const cross = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x);
  return `M${a.x},${a.y} A${r},${r} 0 0 ${cross > 0 ? 1 : 0} ${b.x},${b.y}`;
}

export function doorPlan2D(f: DoorPlanInput, selected: boolean): ReactNode {
  const ink = selected ? SELECTED : INK;
  const t = f.thickness;
  const u = unit(sub(f.end, f.start));
  const n = perp(u);
  const leafN = f.swingRight ? { x: -n.x, y: -n.y } : n;
  const W = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
  const leafT = Math.min(0.04, W * 0.05);
  const parts: ReactNode[] = [];
  const hit: ReactNode[] = [];
  // The opening through the wall: hit area
  hit.push(<polygon key="hit" points={pts([add(f.start, n, t / 2), add(f.end, n, t / 2), add(f.end, n, -t / 2), add(f.start, n, -t / 2)])} fill="transparent" stroke="none" />);

  /** One leaf hinged at `hinge` (on the centre line), closing towards `toward`, open 90°. */
  const leaf = (hinge: Point, toward: Point, width: number, k: number) => {
    const h = add(hinge, leafN, t / 2);
    const tip = add(h, leafN, width);
    const a = unit(sub(toward, hinge));
    const closed = add(h, a, width);
    parts.push(<polygon key={`l${k}`} className="pen-med" points={pts([h, tip, add(tip, a, leafT), add(h, a, leafT)])} fill="#ffffff" stroke={ink} strokeWidth={0.02} />);
    parts.push(<path key={`a${k}`} className="pen-thin" d={arcPath(h, tip, closed)} fill="none" stroke={ink} strokeWidth={0.012} />);
    hit.push(<path key={`h${k}`} d={`${arcPath(h, tip, closed)} L${h.x},${h.y} Z`} fill="transparent" stroke="none" />);
  };

  switch (f.operation) {
    case 'double_swing':
      leaf(f.start, f.end, W / 2, 0);
      leaf(f.end, f.start, W / 2, 1);
      break;
    case 'sliding': {
      const p = W * 0.55, off = t / 6;
      const panel = (a: Point, b: Point, o: number, k: number) => {
        const a1 = add(a, n, o - leafT / 2), b1 = add(b, n, o - leafT / 2);
        parts.push(<polygon key={`p${k}`} className="pen-med" points={pts([a1, b1, add(b1, n, leafT), add(a1, n, leafT)])} fill="#ffffff" stroke={ink} strokeWidth={0.02} />);
      };
      panel(f.start, add(f.start, u, p), off, 0);
      panel(add(f.end, u, -p), f.end, -off, 1);
      break;
    }
    case 'folding': {
      const k = 4, depth = W / (2 * k);
      const zig: Point[] = [];
      for (let i = 0; i <= k; i++) zig.push(add(add(f.start, u, (W * i) / k), leafN, t / 2 + (i % 2 ? depth : 0)));
      parts.push(<polyline key="z" className="pen-med" points={pts(zig)} fill="none" stroke={ink} strokeWidth={0.02} />);
      break;
    }
    case 'revolving': {
      const c = lerp(f.start, f.end, 0.5);
      parts.push(<circle key="c" className="pen-thin" cx={c.x} cy={c.y} r={W / 2} fill="none" stroke={ink} strokeWidth={0.012} />);
      for (const deg of [45, 135]) {
        const r = (deg * Math.PI) / 180 + Math.atan2(u.y, u.x);
        const v = { x: Math.cos(r) * W / 2, y: Math.sin(r) * W / 2 };
        const a = add(c, v, -1), b = add(c, v);
        parts.push(<line key={`r${deg}`} className="pen-med" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ink} strokeWidth={0.02} />);
      }
      break;
    }
    default:
      leaf(f.hingeEnd ? f.end : f.start, f.hingeEnd ? f.start : f.end, W, 0);
  }
  return <>{hit}{parts}</>;
}

export function windowPlan2D(f: OpeningPlanInput & { operation: string }, selected: boolean): ReactNode {
  const ink = selected ? SELECTED : INK;
  const t = f.thickness;
  const u = unit(sub(f.end, f.start));
  const n = perp(u);
  const at = (p: Point, o: number) => add(p, n, o);
  const L = Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y);
  const glass: [Point, Point][] = [];
  if (f.operation === 'sliding') {
    const mid = lerp(f.start, f.end, 0.5), ov = L * 0.05;
    glass.push([at(f.start, t / 10), at(add(mid, u, ov), t / 10)], [at(add(mid, u, -ov), -t / 10), at(f.end, -t / 10)]);
  } else {
    glass.push([at(f.start, t / 12), at(f.end, t / 12)], [at(f.start, -t / 12), at(f.end, -t / 12)]);
  }
  const frame = [at(f.start, t / 2), at(f.end, t / 2), at(f.end, -t / 2), at(f.start, -t / 2)];
  return (
    <>
      {/* Opening: white, outlined by the wall faces and the jambs */}
      <polygon className="pen-thin" points={pts(frame)} fill="#ffffff" stroke={ink} strokeWidth={0.012} />
      {glass.map(([a, b], i) => (
        <line key={i} className="pen-hair" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ink} strokeWidth={0.008} />
      ))}
    </>
  );
}
