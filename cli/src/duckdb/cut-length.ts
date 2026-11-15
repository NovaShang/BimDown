/**
 * Computed `cut_length` of beams and braces: the length between the faces of
 * the columns and girders a member frames into, as the editor's schedules,
 * 3D body and IFC export use it (Revit "Cut Length"); volume and weight use
 * it (braces keep their whole length). Mirrors the editor's elements/_framing.ts (trimAtColumns, trimAtBeams):
 * an end inside a column on the same level stops at that column's face; an
 * end on another beam's centre line (same height, inside its span, not
 * parallel) stops at its side face.
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import { runQuery } from './engine.js';

type P = { x: number; y: number };

interface Footprint { center: P; rot: number; hw: number; hh: number; round: boolean }
interface Seg { id: string; start: P; end: P; hw: number; z: number; depth: number }
interface Member { id: string; partition: string; table: string; start: P; end: P; z: number; length: number }

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Plan half sizes of a structural section (bbox: width × depth; round: diameter). */
export function sectionHalf(shape: string, sizeX?: number, sizeY?: number): { hw: number; hh: number; round: boolean } {
  const s = (shape || 'rect').trim();
  const round = s === 'round' || s === 'round_hollow';
  const w = sizeX ?? (round ? 0.3 : s === 'rect' ? 0.3 : 0.2);
  const d = round ? w : sizeY ?? (s === 'i_shape' ? 0.4 : s === 'rect' ? 0.3 : 0.2);
  return { hw: w / 2, hh: d / 2, round };
}

function toLocal(fp: Footprint, p: P): P {
  const dx = p.x - fp.center.x, dy = p.y - fp.center.y;
  const c = Math.cos(-fp.rot), s = Math.sin(-fp.rot);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function lineInterval(fp: Footprint, a: P, b: P): [number, number] | null {
  const la = toLocal(fp, a), lb = toLocal(fp, b);
  const dx = lb.x - la.x, dy = lb.y - la.y;
  if (fp.round) {
    const r = fp.hw, A = dx * dx + dy * dy;
    if (A < 1e-12) return null;
    const B = 2 * (la.x * dx + la.y * dy), C = la.x * la.x + la.y * la.y - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  }
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d, h] of [[la.x, dx, fp.hw], [la.y, dy, fp.hh]] as const) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(p) > h) return null; continue; }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

export function trimAtColumns(start: P, end: P, columns: Footprint[]): [number, number] {
  let t0 = 0, t1 = 1;
  for (const fp of columns) {
    const reach = Math.max(fp.hw, fp.hh) * 1.5 + 0.01;
    const nearStart = Math.hypot(start.x - fp.center.x, start.y - fp.center.y) <= reach;
    const nearEnd = Math.hypot(end.x - fp.center.x, end.y - fp.center.y) <= reach;
    if (!nearStart && !nearEnd) continue;
    const iv = lineInterval(fp, start, end);
    if (!iv) continue;
    if (nearStart && iv[0] <= 1e-9 && iv[1] >= 0) t0 = Math.max(t0, iv[1]);
    if (nearEnd && iv[1] >= 1 - 1e-9 && iv[0] <= 1) t1 = Math.min(t1, iv[0]);
  }
  return t1 - t0 < 1e-3 ? [0, 1] : [t0, t1];
}

export function trimAtBeams(id: string, start: P, end: P, z: number, beams: Seg[]): [number, number] {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [0, 1];
  const ux = dx / len, uy = dy / len;
  let t0 = 0, t1 = 1;
  for (const b of beams) {
    if (b.id === id || Math.abs(b.z - z) > Math.max(b.depth, 0.05)) continue;
    const bx = b.end.x - b.start.x, by = b.end.y - b.start.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) continue;
    const vx = bx / bl, vy = by / bl;
    const sin = Math.abs(ux * vy - uy * vx);
    if (sin < 0.2) continue;
    for (const [p, atStart] of [[start, true], [end, false]] as const) {
      const wx = p.x - b.start.x, wy = p.y - b.start.y;
      const along = wx * vx + wy * vy;
      const off = Math.abs(wx * vy - wy * vx);
      if (off > b.hw + 0.01 || along <= b.hw + 0.01 || along >= bl - b.hw - 0.01) continue;
      const cut = (b.hw / sin) / len;
      if (atStart) t0 = Math.max(t0, cut); else t1 = Math.min(t1, 1 - cut);
    }
  }
  return t1 - t0 < 1e-3 ? [0, 1] : [t0, t1];
}

async function columnsOf(conn: DuckDBConnection, table: string): Promise<Set<string>> {
  const r = await runQuery(conn, `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`);
  return new Set(r.rows.map((x) => String(x.column_name)));
}

async function rowsOf(conn: DuckDBConnection, table: string, want: string[]): Promise<Record<string, unknown>[]> {
  const cols = await columnsOf(conn, table);
  if (cols.size === 0) return [];
  const sel = want.map((c) => (cols.has(c) ? `"${c}"` : `NULL AS "${c}"`)).join(', ');
  return (await runQuery(conn, `SELECT ${sel} FROM "${table}"`)).rows as Record<string, unknown>[];
}

/** Fill `cut_length` on beam / brace (call once every table has its geometry, before volumes). */
export async function injectCutLength(conn: DuckDBConnection, tables: readonly string[]): Promise<void> {
  const framing = tables.filter((t) => t === 'beam' || t === 'brace');
  if (framing.length === 0) return;
  // Columns per level partition
  const columns = new Map<string, Footprint[]>();
  for (const t of ['structure_column', 'column']) {
    if (!tables.includes(t)) continue;
    for (const r of await rowsOf(conn, t, ['_partition', 'x', 'y', 'rotation', 'shape', 'size_x', 'size_y'])) {
      const x = num(r.x), y = num(r.y);
      if (x === undefined || y === undefined) continue;
      const h = sectionHalf(String(r.shape ?? ''), num(r.size_x), num(r.size_y));
      const list = columns.get(String(r._partition)) ?? [];
      list.push({ center: { x, y }, rot: ((num(r.rotation) ?? 0) * Math.PI) / 180, ...h });
      columns.set(String(r._partition), list);
    }
  }
  const members: Member[] = [];
  const girders = new Map<string, Seg[]>();
  for (const t of framing) {
    for (const r of await rowsOf(conn, t, ['id', '_partition', 'start_x', 'start_y', 'end_x', 'end_y', 'start_z', 'end_z', 'base_offset', 'length', 'shape', 'size_x', 'size_y'])) {
      const sx = num(r.start_x), sy = num(r.start_y), ex = num(r.end_x), ey = num(r.end_y), length = num(r.length);
      if (sx === undefined || sy === undefined || ex === undefined || ey === undefined || length === undefined) continue;
      const base = num(r.base_offset) ?? 0;
      const z = ((num(r.start_z) ?? base) + (num(r.end_z) ?? base)) / 2;
      const m: Member = { id: String(r.id), partition: String(r._partition), table: t, start: { x: sx, y: sy }, end: { x: ex, y: ey }, z, length };
      members.push(m);
      if (t === 'beam') {
        const h = sectionHalf(String(r.shape ?? ''), num(r.size_x), num(r.size_y));
        const list = girders.get(m.partition) ?? [];
        list.push({ id: m.id, start: m.start, end: m.end, hw: h.hw, z, depth: 2 * h.hh });
        girders.set(m.partition, list);
      }
    }
  }
  const byTable = new Map<string, { id: string; partition: string; cut: number }[]>();
  for (const m of members) {
    // Braces run corner to corner of a bay: their whole length (as the editor schedules them)
    if (m.table === 'brace') { (byTable.get(m.table) ?? byTable.set(m.table, []).get(m.table)!).push({ id: m.id, partition: m.partition, cut: m.length }); continue; }
    const body = trimAtBeams(m.id, m.start, m.end, m.z, girders.get(m.partition) ?? []);
    const [c0, c1] = trimAtColumns(m.start, m.end, columns.get(m.partition) ?? []);
    const k = Math.max(0, Math.min(1, Math.min(c1, body[1])) - Math.max(0, Math.max(c0, body[0])));
    const list = byTable.get(m.table) ?? [];
    list.push({ id: m.id, partition: m.partition, cut: Math.round(m.length * k * 1e4) / 1e4 });
    byTable.set(m.table, list);
  }
  for (const t of framing) {
    const cols = await columnsOf(conn, t);
    if (!cols.has('cut_length')) await runQuery(conn, `ALTER TABLE "${t}" ADD COLUMN "cut_length" DOUBLE`);
    await runQuery(conn, `UPDATE "${t}" SET cut_length = TRY_CAST(NULLIF(CAST("length" AS VARCHAR), '') AS DOUBLE)`);
    const list = byTable.get(t) ?? [];
    for (let i = 0; i < list.length; i += 500) {
      const values = list.slice(i, i + 500).map((r) => `('${r.id.replace(/'/g, "''")}', '${r.partition.replace(/'/g, "''")}', ${r.cut})`).join(', ');
      await runQuery(conn, `UPDATE "${t}" SET cut_length = v.cut FROM (VALUES ${values}) AS v(id, part, cut)
        WHERE CAST("${t}".id AS VARCHAR) = v.id AND CAST("${t}"._partition AS VARCHAR) = v.part`);
    }
  }
}
