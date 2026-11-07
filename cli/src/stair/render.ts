/**
 * Plan symbols of stairs for `bimdown render`: every run with its treads
 * (dashed beyond the 1.2 m plan cut) and break line, landings, the walking
 * line over all runs with UP, and railings — sketched ones along their path,
 * stair railings along the path derived from the stair. Multi-storey stairs
 * also draw on the storeys they repeat on.
 */
import { loadStairs, type StairModel } from './model.js';
import { railPlan, runPlan, walkingLine, STAIR_CUT_HEIGHT, type Point, type StairRun } from './geometry.js';
import { UNIT_TO_M, projectUnits } from '../utils/units.js';

export interface StairRendered {
  tableName: string;
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const STAIR = '#f4a261';
const RAILING = '#546e7a';
const f = (n: number) => Number(n.toFixed(4)).toString();
const pts = (p: Point[]) => p.map(q => `${f(q.x)},${f(q.y)}`).join(' ');

function boundsOf(points: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function scaled(r: StairRun, scale: number): StairRun {
  return scale === 1 ? r : { ...r, startZ: r.startZ * scale, endZ: r.endZ * scale };
}

function stairSvg(s: StairModel, scale: number, cutZ: number, k: number): StairRendered | null {
  if (s.asm.runs.length === 0) return null;
  const parts: string[] = [];
  const all: Point[] = [];
  for (const l of s.asm.landings) {
    const above = l.top * scale > cutZ;
    parts.push(`<polygon points="${pts(l.vertices)}" fill="rgba(244,162,97,0.15)" stroke="${STAIR}" stroke-width="${f(0.03 * k)}"${above ? ` stroke-dasharray="${f(0.12 * k)},${f(0.06 * k)}"` : ''} />`);
    all.push(...l.vertices);
  }
  for (const r0 of s.asm.runs) {
    const plan = runPlan(scaled(r0, scale), cutZ);
    parts.push(`<polygon points="${pts(plan.outline)}" fill="rgba(244,162,97,0.15)" stroke="none" />`);
    for (const l of plan.lines) {
      parts.push(`<line x1="${f(l.a.x)}" y1="${f(l.a.y)}" x2="${f(l.b.x)}" y2="${f(l.b.y)}" stroke="${STAIR}" stroke-width="${f(0.025 * k)}"${l.above ? ` stroke-dasharray="${f(0.1 * k)},${f(0.06 * k)}"` : ''} />`);
    }
    if (plan.breakLine) parts.push(`<polyline points="${pts(plan.breakLine)}" fill="none" stroke="${STAIR}" stroke-width="${f(0.03 * k)}" />`);
    all.push(...plan.outline);
  }
  const walk = walkingLine(s.asm);
  if (walk.length >= 2) {
    const a = walk[walk.length - 2], b = walk[walk.length - 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    const head = Math.min(0.3 * k, s.asm.runs[0].width * 0.3);
    const back = { x: b.x - u.x * head, y: b.y - u.y * head };
    parts.push(`<polyline points="${pts([...walk.slice(0, -1), back])}" fill="none" stroke="${STAIR}" stroke-width="${f(0.025 * k)}" />`);
    parts.push(`<polygon points="${pts([b, { x: back.x - u.y * head * 0.4, y: back.y + u.x * head * 0.4 }, { x: back.x + u.y * head * 0.4, y: back.y - u.x * head * 0.4 }])}" fill="${STAIR}" />`);
    parts.push(`<circle cx="${f(walk[0].x)}" cy="${f(walk[0].y)}" r="${f(0.06 * k)}" fill="${STAIR}" />`);
    const r0 = s.asm.runs[0];
    const off = Math.min(0.6 * k, r0.length * 0.25);
    const lp = { x: walk[0].x + r0.u.x * off - r0.u.y * r0.width * 0.22, y: walk[0].y + r0.u.y * off + r0.u.x * r0.width * 0.22 };
    const up = r0.endZ >= r0.startZ;
    parts.push(`<text x="0" y="0" transform="translate(${f(lp.x)},${f(lp.y)}) scale(1,-1)" font-size="${f(0.25 * k)}" font-family="sans-serif" font-weight="bold" fill="${STAIR}" text-anchor="middle" dominant-baseline="central">${up ? 'UP' : 'DN'}</text>`);
  }
  return { tableName: 'stair', svg: `    <g id="${s.id}">${parts.join('')}</g>`, bounds: boundsOf(all) };
}

/** Stair, run, landing and railing symbols for one level (plus repetitions of lower multi-storey stairs). */
export function renderStairs(projectDir: string, levelId: string): StairRendered[] {
  const k = 1 / UNIT_TO_M[projectUnits(projectDir)];
  const cutZ = STAIR_CUT_HEIGHT * k;
  const out: StairRendered[] = [];
  for (const d of loadStairs(projectDir)) {
    const here = d.dir === levelId || d.dir === 'global';
    /** Which repetition of a stair shows on this level (-1: none). */
    const repOn = (s: StairModel | undefined): number => {
      if (here) return 0;
      return s ? s.reps.findIndex(r => r.index > 0 && r.levelId === levelId) : -1;
    };
    for (const s of d.stairs) {
      const i = repOn(s);
      const r = i >= 0 ? stairSvg(s, s.reps[i].scale, cutZ, k) : null;
      if (r) out.push(r);
    }
    for (const rl of d.railings) {
      const i = rl.host === 'stair' ? repOn(d.stairs.find(s => s.id === rl.row.host_id)) : here ? 0 : -1;
      const segs = i >= 0 ? rl.paths[i] : undefined;
      if (!segs || segs.length === 0) continue;
      const plan = railPlan(segs);
      if (plan.length < 2) continue;
      out.push({
        tableName: 'railing',
        svg: `    <polyline id="${rl.id}" points="${pts(plan)}" fill="none" stroke="${RAILING}" stroke-width="${f(0.05 * k)}" stroke-linejoin="miter" />`,
        bounds: boundsOf(plan),
      });
    }
  }
  return out;
}
