/**
 * MEP plan graphics for `bimdown render`, matching the editor's plan view:
 * ducts / pipes / trays / conduit as bands at their real width in system
 * colours, pulled back at passive fittings that draw as radiused elbows,
 * tees / taps / crosses and reducer cones; rise / drop symbols on vertical
 * segments; insulation and flex hatching; system + size tags and slope
 * arrows; terminal and equipment symbols by type with tags; inline
 * accessories (valves, dampers) as their plan symbols.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from './utils/csv.js';
import { parseGeoJsonFile, type BimDownFeature } from './utils/geojson.js';

export interface MepRendered {
  tableName: string;
  svg: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

type V3 = [number, number, number];
type P = { x: number; y: number };

export const MEP_RENDER_TABLES = new Set(['duct', 'pipe', 'cable_tray', 'conduit', 'equipment', 'terminal', 'mep_node']);
const CURVES = ['duct', 'pipe', 'cable_tray', 'conduit'];
const DEFAULT_COLOR: Record<string, string> = { duct: '#00b4d8', pipe: '#06d6a0', cable_tray: '#ffd166', conduit: '#ffd166', equipment: '#e63946', terminal: '#f77f00', mep_node: '#888888' };

/** Same curated table as the editor (_mepLineShared.tsx SYSTEM_COLORS). */
const SYSTEM_COLORS: Record<string, string> = {
  SA: '#3b82f6', RA: '#60a5fa', EA: '#a855f7', OA: '#22d3ee', GE: '#7c3aed',
  CHWS: '#06b6d4', CHWR: '#0891b2', HWS: '#f97316', HWR: '#ea580c', CWS: '#10b981', CWR: '#059669',
  RF: '#ec4899', SF: '#fb923c', DW: '#1d4ed8', DCW: '#3b82f6', DHW: '#dc2626', DHWR: '#b91c1c',
  SS: '#92400e', VENT: '#a16207', SD: '#0369a1', GAS: '#facc15',
  DHWS: '#dc2626', SAN: '#92400e', V: '#a16207', G: '#facc15', CD: '#14b8a6', FP: '#ef4444',
  PWR: '#eab308', LTG: '#f59e0b',
  NP: '#fde047', EM: '#f43f5e', LV: '#eab308', HV: '#ca8a04', DATA: '#22c55e', FA: '#ef4444', SEC: '#a3a3a3',
};

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 60%, 50%)`;
}

const f3 = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(3)).toString() : '0');
const pts = (ps: P[]) => ps.map(p => `${f3(p.x)},${f3(p.y)}`).join(' ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v: unknown, d = 0) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : d; };

interface Curve { id: string; table: string; a: V3; b: V3; row: Record<string, string>; w: number; h: number; round: boolean }
interface Host { id: string; table: string; pos: V3; rot: number; size: number[]; row: Record<string, string> }

function load(dirs: string[]) {
  const curves: Curve[] = [];
  const hosts: Host[] = [];
  const ports: { hostId: string; row: Record<string, string> }[] = [];
  for (const d of dirs) {
    for (const t of [...CURVES, 'equipment', 'terminal', 'mep_node']) {
      const csvPath = join(d, `${t}.csv`), geoPath = join(d, `${t}.geojson`);
      if (!existsSync(csvPath) || !existsSync(geoPath)) continue;
      const rows = new Map(readCsv(csvPath).rows.map(r => [r.id, r]));
      let feats: BimDownFeature[] = [];
      try { feats = parseGeoJsonFile(geoPath).features; } catch { continue; }
      for (const f of feats) {
        const id = String(f.properties?.id ?? '');
        const row = rows.get(id);
        if (!row) continue;
        const g = f.geometry as { type: string; coordinates: number[] | number[][] };
        if (CURVES.includes(t) && g.type === 'LineString') {
          const c = g.coordinates as number[][];
          const a = c[0], b = c[c.length - 1];
          const round = (row.shape || (t === 'pipe' || t === 'conduit' ? 'round' : 'rect')) === 'round';
          const w = num(row.size_x, t === 'duct' ? 0.3 : t === 'pipe' ? 0.1 : t === 'cable_tray' ? 0.2 : 0.05);
          curves.push({ id, table: t, a: [a[0], a[1], a[2] ?? 0], b: [b[0], b[1], b[2] ?? 0], row, w, h: round ? w : num(row.size_y, w), round });
        } else if (g.type === 'Point') {
          const c = g.coordinates as number[];
          const size = Array.isArray(f.properties?.size) ? (f.properties.size as number[]) : [];
          hosts.push({ id, table: t, pos: [c[0], c[1], c[2] ?? 0], rot: num(f.properties?.rotation), size, row });
        }
      }
    }
    const cp = join(d, 'connector.csv');
    if (existsSync(cp)) for (const r of readCsv(cp).rows) ports.push({ hostId: r.host_id, row: r });
  }
  return { curves, hosts, ports };
}

function systemColors(globalDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const p = join(globalDir, 'mep_system.csv');
  if (!existsSync(p)) return out;
  for (const r of readCsv(p).rows) if (r.system_type && r.color) out.set(r.system_type.trim(), r.color.trim());
  return out;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Leg { curve: Curve; side: 'a' | 'b'; dir: V3; trim: number; width: number }

/** Plan text along `dir`, readable left to right. */
function text(x: number, y: number, dir: P | null, size: number, color: string, s: string, weight = 500): string {
  let ang = dir ? (Math.atan2(dir.y, dir.x) * 180) / Math.PI : 0;
  if (ang > 90.01) ang -= 180;
  if (ang < -89.99) ang += 180;
  return `<text x="0" y="0" font-size="${f3(size)}" font-family="sans-serif" font-weight="${weight}" fill="${color}" text-anchor="middle" dominant-baseline="central" transform="translate(${f3(x)},${f3(y)}) rotate(${f3(ang)}) scale(1,-1)">${esc(s)}</text>`;
}

function sizeLabel(c: Curve): string {
  const mm = (v: number) => Math.round(v * 1000);
  const sys = (c.row.system_type || '').trim();
  let size: string;
  if (c.round) {
    const d = mm(c.w);
    const dn = c.table === 'pipe' ? [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300].find(n => Math.abs(n - d) <= Math.max(2, n * 0.12)) : undefined;
    size = dn ? `DN${dn}` : `Ø${d}`;
  } else size = `${mm(c.w)}×${mm(c.h)}`;
  return sys ? `${sys} ${size}` : size;
}

export function renderMep(dirs: string[], globalDir: string): MepRendered[] {
  const { curves, hosts, ports } = load(dirs);
  if (curves.length === 0 && hosts.length === 0) return [];
  const projectColors = systemColors(globalDir);
  const colorOf = (sys: string, table: string) => {
    const s = (sys || '').split(',')[0].trim();
    if (!s) return DEFAULT_COLOR[table] ?? '#666';
    return projectColors.get(s) ?? SYSTEM_COLORS[s] ?? hashColor(s);
  };
  const out: MepRendered[] = [];
  const push = (tableName: string, svg: string, ps: P[], pad = 0) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ps) { minX = Math.min(minX, p.x - pad); minY = Math.min(minY, p.y - pad); maxX = Math.max(maxX, p.x + pad); maxY = Math.max(maxY, p.y + pad); }
    out.push({ tableName, svg, bounds: { minX, minY, maxX, maxY } });
  };

  // ── Passive fittings: legs and trims (same rules as the editor) ──
  const hostById = new Map(hosts.map(h => [h.id, h]));
  const legsByNode = new Map<string, Leg[]>();
  for (const c of curves) {
    for (const ref of [c.row.from, c.row.to]) {
      const hid = (ref || '').split(':')[0];
      const h = hid && !ref.includes(':') ? hostById.get(hid) : undefined;
      if (!h || h.table !== 'mep_node' || (h.row.kind || '').trim()) continue;
      const da = Math.hypot(c.a[0] - h.pos[0], c.a[1] - h.pos[1]) + Math.abs(c.a[2] - h.pos[2]);
      const db = Math.hypot(c.b[0] - h.pos[0], c.b[1] - h.pos[1]) + Math.abs(c.b[2] - h.pos[2]);
      const side: 'a' | 'b' = da <= db ? 'a' : 'b';
      const far = side === 'a' ? c.b : c.a;
      const dir = norm3(sub(far, h.pos));
      const list = legsByNode.get(h.id) ?? [];
      if (list.some(l => l.curve === c)) continue;
      list.push({ curve: c, side, dir, trim: 0, width: c.w });
      legsByNode.set(h.id, list);
    }
  }
  const trimOf = new Map<string, number>(); // `${curveId}:${side}`
  // One tag per straight run: a segment whose start continues a same-size run is not tagged.
  const untagged = new Set<string>();
  const sameRun = (a: Curve, b: Curve) => a.table === b.table && (a.row.system_type || '') === (b.row.system_type || '') && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;
  const markStraight = (x: Leg, y: Leg) => {
    if (x.side === 'a' && sameRun(x.curve, y.curve)) untagged.add(x.curve.id);
    if (y.side === 'a' && sameRun(x.curve, y.curve)) untagged.add(y.curve.id);
  };
  const fittingSvg: { node: Host; svg: string; ps: P[] }[] = [];
  for (const [nodeId, legs] of legsByNode) {
    const node = hostById.get(nodeId)!;
    const c: P = { x: node.pos[0], y: node.pos[1] };
    const color = colorOf(node.row.system_type || legs[0].curve.row.system_type || '', legs[0].curve.table);
    const sw = legs[0].curve.table === 'duct' || legs[0].curve.table === 'cable_tray' ? 0.025 : 0.02;
    const horiz = (l: Leg) => Math.abs(l.dir[2]) < 0.5;
    const pd = (l: Leg): P => { const hh = Math.hypot(l.dir[0], l.dir[1]) || 1; return { x: l.dir[0] / hh, y: l.dir[1] / hh }; };
    const curveLen = (l: Leg) => len3(sub(l.curve.b, l.curve.a));
    const clamp = (l: Leg, t: number) => Math.max(0, Math.min(t, curveLen(l) * 0.45));
    const collar = (l: Leg) => Math.max(0.025, 0.08 * Math.max(l.curve.w, l.curve.h));
    const band = (a: P, u: P, L: number, W: number): P[] => {
      const n = { x: -u.y, y: u.x }, hw = W / 2, b = { x: a.x + u.x * L, y: a.y + u.y * L };
      return [{ x: a.x + n.x * hw, y: a.y + n.y * hw }, { x: b.x + n.x * hw, y: b.y + n.y * hw }, { x: b.x - n.x * hw, y: b.y - n.y * hw }, { x: a.x - n.x * hw, y: a.y - n.y * hw }];
    };
    const poly = (ps: P[], kind: string) => `<polygon data-mep="${kind}" points="${pts(ps)}" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="${sw}" />`;
    let kind = 'coupling';
    let svg = '';
    const allPs: P[] = [c];
    const n = legs.length;
    const hint = (node.row.fitting || '').trim();
    if (n === 2 && dot3(legs[0].dir, legs[1].dir) < -0.985) {
      const [a, b] = legs;
      markStraight(a, b);
      if (Math.abs(a.curve.w - b.curve.w) > 1e-3 || Math.abs(a.curve.h - b.curve.h) > 1e-3 || a.curve.round !== b.curve.round) {
        kind = a.curve.round === b.curve.round ? 'reducer' : 'transition';
        const L = Math.max(0.1, (Math.max(Math.abs(a.curve.w - b.curve.w), Math.abs(a.curve.h - b.curve.h), 0.05) / 2) / Math.tan(20 * Math.PI / 180));
        a.trim = clamp(a, L / 2); b.trim = clamp(b, L / 2);
        if (horiz(a) && horiz(b)) {
          const da = pd(a), db = pd(b), nn = { x: -da.y, y: da.x };
          const pa = { x: c.x + da.x * a.trim, y: c.y + da.y * a.trim }, pb = { x: c.x + db.x * b.trim, y: c.y + db.y * b.trim };
          const q = [{ x: pa.x + nn.x * a.width / 2, y: pa.y + nn.y * a.width / 2 }, { x: pb.x + nn.x * b.width / 2, y: pb.y + nn.y * b.width / 2 },
            { x: pb.x - nn.x * b.width / 2, y: pb.y - nn.y * b.width / 2 }, { x: pa.x - nn.x * a.width / 2, y: pa.y - nn.y * a.width / 2 }];
          svg = poly(q, kind); allPs.push(...q);
        }
      }
    } else if (n === 2) {
      kind = 'elbow';
      const [a, b] = legs;
      const defl = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot3(a.dir, b.dir))));
      const W = Math.max(a.curve.w, b.curve.w);
      let R = (a.curve.table === 'pipe' ? 1.5 : a.curve.table === 'conduit' ? 4 : 1) * W;
      const tanH = Math.tan(defl / 2);
      const maxT = Math.min(curveLen(a), curveLen(b)) * 0.45;
      if (R * tanH > maxT) R = maxT / tanH;
      if (R >= W / 2 + 1e-4) {
        a.trim = b.trim = R * tanH;
        if (horiz(a) && horiz(b)) {
          const da = pd(a), db = pd(b);
          const bx = da.x + db.x, by = da.y + db.y, bl = Math.hypot(bx, by) || 1;
          const o = { x: c.x + bx / bl * R / Math.cos(defl / 2), y: c.y + by / bl * R / Math.cos(defl / 2) };
          const ta = { x: c.x + da.x * a.trim, y: c.y + da.y * a.trim }, tb = { x: c.x + db.x * b.trim, y: c.y + db.y * b.trim };
          const a0 = Math.atan2(ta.y - o.y, ta.x - o.x), a1 = Math.atan2(tb.y - o.y, tb.x - o.x);
          let sweep = a1 - a0;
          while (sweep > Math.PI) sweep -= 2 * Math.PI;
          while (sweep < -Math.PI) sweep += 2 * Math.PI;
          const arc = (r: number) => Array.from({ length: 13 }, (_, i) => ({ x: o.x + Math.cos(a0 + sweep * i / 12) * r, y: o.y + Math.sin(a0 + sweep * i / 12) * r }));
          const outer = arc(R + W / 2), inner = arc(Math.max(R - W / 2, 0)).reverse();
          svg = poly([...outer, ...inner], kind); allPs.push(...outer);
        } else {
          const h = horiz(a) ? a : horiz(b) ? b : null;
          if (h) { const q = band(c, pd(h), h.trim, h.width); svg = poly(q, kind); allPs.push(...q); }
        }
      }
    } else if (n >= 3) {
      let best: [number, number] | null = null, bd = 1;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = dot3(legs[i].dir, legs[j].dir); if (d < bd) { bd = d; best = [i, j]; } }
      const main = best && bd < -0.985 ? best : null;
      if (main) markStraight(legs[main[0]], legs[main[1]]);
      if (main && n === 3) {
        const br = legs.find((_, i) => i !== main[0] && i !== main[1])!;
        const m1 = legs[main[0]], m2 = legs[main[1]];
        const big = m1.curve.w * m1.curve.h >= m2.curve.w * m2.curve.h ? m1 : m2;
        const tap = hint === 'tap' || (hint !== 'tee' && br.curve.table === 'duct' && ((br.curve.round && !big.curve.round) || br.curve.w <= 0.5 * big.curve.w));
        kind = tap ? 'tap' : 'tee';
        const mainExt = Math.abs(br.dir[2]) > 0.5 ? big.curve.h : big.curve.w;
        if (tap) br.trim = clamp(br, mainExt / 2);
        else {
          m1.trim = clamp(m1, br.curve.w / 2 + collar(m1)); m2.trim = clamp(m2, br.curve.w / 2 + collar(m2));
          br.trim = clamp(br, mainExt / 2 + collar(br));
        }
      } else {
        kind = n === 4 && main ? 'cross' : n === 3 ? 'wye' : 'manifold';
        for (const l of legs) {
          let ext = 0;
          for (const o of legs) if (o !== l) ext = Math.max(ext, o.curve.w);
          l.trim = clamp(l, ext / 2 + collar(l));
        }
      }
      for (const l of legs) {
        if (l.trim <= 1e-4 || !horiz(l)) continue;
        const q = band(c, pd(l), l.trim, l.width);
        svg += poly(q, kind); allPs.push(...q);
      }
      if (kind === 'tap') svg += `<circle data-mep="tap" cx="${f3(c.x)}" cy="${f3(c.y)}" r="0.001" fill="none" />`;
    } else if (n === 1) {
      kind = hint === 'open' ? 'open' : 'cap';
      if (kind === 'cap' && horiz(legs[0])) {
        const d = pd(legs[0]);
        const q = band({ x: c.x - d.x * 0.02, y: c.y - d.y * 0.02 }, d, 0.02, legs[0].width * 1.06);
        svg = poly(q, kind); allPs.push(...q);
      }
    }
    for (const l of legs) if (l.trim > 0) trimOf.set(`${l.curve.id}:${l.side}`, l.trim);
    if (svg) fittingSvg.push({ node, svg, ps: allPs });
  }

  // ── Curves ──
  for (const c of curves) {
    const color = colorOf(c.row.system_type || '', c.table);
    const sw = c.table === 'duct' || c.table === 'cable_tray' ? 0.025 : 0.02;
    const d = sub(c.b, c.a);
    const horLen = Math.hypot(d[0], d[1]);
    if (horLen < 1e-3) {
      // Vertical segment: section with rise (X) or drop (one diagonal).
      // Rise or drop, seen from the run it joins on this level (as in the editor).
      const joinsRun = (ref: string | undefined) => {
        if (!ref) return false;
        const [hid, port] = ref.split(':');
        const legs = legsByNode.get(hid);
        if (legs) return legs.some(l => Math.abs(l.dir[2]) < 0.5);
        return !!port && hostById.has(hid);
      };
      const lowerIsA = c.a[2] <= c.b[2];
      const lowerJoins = joinsRun(lowerIsA ? c.row.from : c.row.to), upperJoins = joinsRun(lowerIsA ? c.row.to : c.row.from);
      const up = lowerJoins && !upperJoins ? true : upperJoins && !lowerJoins ? false : c.b[2] >= c.a[2];
      const x = c.a[0], y = c.a[1], hw = c.w / 2, hh = c.h / 2;
      const kind = up ? 'riser-up' : 'riser-down';
      const shape = c.round
        ? `<circle cx="${f3(x)}" cy="${f3(y)}" r="${f3(hw)}" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="${sw}" />`
        : `<rect x="${f3(x - hw)}" y="${f3(y - hh)}" width="${f3(c.w)}" height="${f3(c.h)}" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="${sw}" />`;
      const k = c.round ? 0.7071 : 1;
      const d1 = `<line x1="${f3(x - hw * k)}" y1="${f3(y - hh * k)}" x2="${f3(x + hw * k)}" y2="${f3(y + hh * k)}" stroke="${color}" stroke-width="${sw * 0.8}" />`;
      const d2 = `<line x1="${f3(x - hw * k)}" y1="${f3(y + hh * k)}" x2="${f3(x + hw * k)}" y2="${f3(y - hh * k)}" stroke="${color}" stroke-width="${sw * 0.8}" />`;
      push(c.table, `    <g id="${c.id}" data-mep="${kind}">${shape}${d1}${up ? d2 : ''}</g>`, [{ x, y }], Math.max(hw, hh));
      continue;
    }
    const u = { x: d[0] / horLen, y: d[1] / horLen }, n = { x: -u.y, y: u.x };
    const ta = trimOf.get(`${c.id}:a`) ?? 0, tb = trimOf.get(`${c.id}:b`) ?? 0;
    const L3 = len3(d);
    const pa = { x: c.a[0] + u.x * ta * horLen / L3, y: c.a[1] + u.y * ta * horLen / L3 };
    const pb = { x: c.b[0] - u.x * tb * horLen / L3, y: c.b[1] - u.y * tb * horLen / L3 };
    const hw = c.w / 2;
    const q = [{ x: pa.x + n.x * hw, y: pa.y + n.y * hw }, { x: pb.x + n.x * hw, y: pb.y + n.y * hw }, { x: pb.x - n.x * hw, y: pb.y - n.y * hw }, { x: pa.x - n.x * hw, y: pa.y - n.y * hw }];
    let svg = `<polygon points="${pts(q)}" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="${sw}" />`;
    const ins = num(c.row.insulation_thickness);
    if (ins > 0) {
      for (const s of [1, -1]) {
        const o = s * (hw + ins);
        svg += `<line x1="${f3(pa.x + n.x * o)}" y1="${f3(pa.y + n.y * o)}" x2="${f3(pb.x + n.x * o)}" y2="${f3(pb.y + n.y * o)}" stroke="${color}" stroke-width="${sw * 0.6}" stroke-dasharray="0.08,0.05" />`;
      }
    }
    if ((c.row.flexible || '').toLowerCase() === 'true') {
      const L = Math.hypot(pb.x - pa.x, pb.y - pa.y), step = Math.max(0.08, Math.min(0.2, hw));
      const zz: P[] = [];
      for (let s = 0, k = 0; s <= L + 1e-9; s += step, k++) zz.push({ x: pa.x + u.x * Math.min(s, L) + n.x * (k % 2 ? 1 : -1) * hw * 0.85, y: pa.y + u.y * Math.min(s, L) + n.y * (k % 2 ? 1 : -1) * hw * 0.85 });
      svg += `<polyline points="${pts(zz)}" fill="none" stroke="${color}" stroke-width="${sw * 0.6}" />`;
    }
    const label = untagged.has(c.id) ? '' : sizeLabel(c);
    const font = c.table === 'duct' || c.table === 'cable_tray' ? 0.2 : 0.15;
    const slope = (c.b[2] - c.a[2]) / horLen;
    const tag = label + (c.table === 'pipe' && Math.abs(slope) >= 0.001 ? `  i=${(Math.abs(slope) * 100).toFixed(1)}%` : '');
    if (label && horLen >= Math.max(1, tag.length * font * 0.62 + 0.3)) {
      const m = { x: (c.a[0] + c.b[0]) / 2 + n.x * (hw + ins + font * 0.9), y: (c.a[1] + c.b[1]) / 2 + n.y * (hw + ins + font * 0.9) };
      svg += text(m.x, m.y, u, font, color, tag);
    }
    if (c.table === 'pipe' && Math.abs(slope) >= 0.001 && horLen > 0.6) {
      const down = slope < 0 ? 1 : -1, L = Math.min(0.6, horLen * 0.3), off = -(hw + ins + 0.12);
      const mc = { x: (c.a[0] + c.b[0]) / 2 + n.x * off, y: (c.a[1] + c.b[1]) / 2 + n.y * off };
      const a = { x: mc.x - u.x * down * L / 2, y: mc.y - u.y * down * L / 2 }, b = { x: mc.x + u.x * down * L / 2, y: mc.y + u.y * down * L / 2 };
      const bk = { x: b.x - u.x * down * 0.08, y: b.y - u.y * down * 0.08 };
      svg += `<g data-mep="slope"><line x1="${f3(a.x)}" y1="${f3(a.y)}" x2="${f3(b.x)}" y2="${f3(b.y)}" stroke="${color}" stroke-width="0.015" /><polygon points="${pts([b, { x: bk.x + n.x * 0.04, y: bk.y + n.y * 0.04 }, { x: bk.x - n.x * 0.04, y: bk.y - n.y * 0.04 }])}" fill="${color}" /></g>`;
    }
    push(c.table, `    <g id="${c.id}">${svg}</g>`, q, ins);
  }
  for (const f of fittingSvg) push('mep_node', `    <g id="${f.node.id}">${f.svg}</g>`, f.ps);

  // ── Devices and accessories ──
  const portOf = new Map<string, Record<string, string>[]>();
  for (const p of ports) { const l = portOf.get(p.hostId) ?? []; l.push(p.row); portOf.set(p.hostId, l); }
  for (const h of hosts) {
    if (h.table === 'mep_node') {
      const kind = (h.row.kind || '').trim();
      if (!kind) continue;
      const leg = curves.find(c => [c.row.from, c.row.to].some(r => (r || '').split(':')[0] === h.id));
      const color = colorOf(h.row.system_type || leg?.row.system_type || '', leg?.table ?? 'pipe');
      const W = leg ? leg.w : 0.05;
      const L = leg?.table === 'duct' ? (kind === 'fire_damper' ? 0.3 : 0.2) : Math.max(0.15, Math.min(0.5, W * 3));
      const H = Math.max(kind.includes('damper') ? W : W * 1.6, 0.09);
      const svg = accessorySvg(kind, L, H, color);
      push('mep_node', `    <g id="${h.id}" data-mep="${kind}" transform="translate(${f3(h.pos[0])},${f3(h.pos[1])}) rotate(${f3(h.rot)})">${svg}</g>`, [{ x: h.pos[0], y: h.pos[1] }], L / 2);
      continue;
    }
    const w = num(h.size[0], 0.3), d = num(h.size[1], w);
    const type = (h.table === 'equipment' ? h.row.equipment_type : h.row.terminal_type) || 'other';
    const sys = (h.row.system_type || '').split(',')[0].trim();
    const color = sys ? colorOf(sys, h.table) : (TERMINAL_COLORS[type] ?? DEFAULT_COLOR[h.table]);
    const sym = h.table === 'equipment' ? equipmentSvg(type, w, d, color) : terminalSvg(type, w, d, color);
    let svg = `<g transform="translate(${f3(h.pos[0])},${f3(h.pos[1])}) rotate(${f3(h.rot)})">${sym}</g>`;
    if (h.table === 'equipment') {
      const tag = h.row.number || EQUIPMENT_ABBR[type] || 'EQ';
      svg += text(h.pos[0], h.pos[1], null, Math.max(0.14, Math.min(0.3, Math.min(w, d) * 0.3)), color, tag, 600);
    } else if (num(h.row.flow) > 0 && /diffuser|grille/.test(type)) {
      svg += text(h.pos[0], h.pos[1] - d / 2 - 0.12, null, 0.12, color, `${Math.round(num(h.row.flow))} L/s`, 600);
    }
    push(h.table, `    <g id="${h.id}" data-mep="${type}">${svg}</g>`, [{ x: h.pos[0], y: h.pos[1] }], Math.max(w, d) / 2);
  }
  return out;
}

const TERMINAL_COLORS: Record<string, string> = {
  light_fixture: '#c99a06', emergency_light: '#c99a06', power_outlet: '#a16207', switch: '#a16207',
  junction_box: '#a16207', data_outlet: '#15803d', fire_alarm_device: '#dc2626', sprinkler_head: '#dc2626',
};
const EQUIPMENT_ABBR: Record<string, string> = {
  ahu: 'AHU', fcu: 'FCU', vav: 'VAV', chiller: 'CH', boiler: 'B', cooling_tower: 'CT', fan: 'F', pump: 'P', coil: 'C',
  transformer: 'TX', panelboard: 'PNL', generator: 'GEN', water_heater: 'WH', tank: 'T', other: 'EQ',
};

function ln(a: P, b: P, c: string, sw: number): string {
  return `<line x1="${f3(a.x)}" y1="${f3(a.y)}" x2="${f3(b.x)}" y2="${f3(b.y)}" stroke="${c}" stroke-width="${f3(sw)}" />`;
}

/** Terminal plan symbols (same shapes as the editor's planSymbols.tsx). */
function terminalSvg(type: string, w: number, d: number, c: string): string {
  const hw = w / 2, hd = d / 2, r = Math.min(hw, hd), sw = Math.max(0.012, Math.min(w, d) * 0.04);
  const fill = `fill="${c}" fill-opacity="0.15" stroke="${c}" stroke-width="${f3(sw)}"`;
  const rect = (x0 = -hw, y0 = -hd, ww = w, dd = d) => `<rect x="${f3(x0)}" y="${f3(y0)}" width="${f3(ww)}" height="${f3(dd)}" ${fill} />`;
  const circ = (rr = r) => `<circle cx="0" cy="0" r="${f3(rr)}" ${fill} />`;
  const X = ln({ x: -hw, y: -hd }, { x: hw, y: hd }, c, sw) + ln({ x: -hw, y: hd }, { x: hw, y: -hd }, c, sw);
  switch (type) {
    case 'supply_air_diffuser': return rect() + rect(-hw * 0.55, -hd * 0.55, w * 0.55, d * 0.55) + X;
    case 'return_air_grille': return rect() + ln({ x: -hw, y: -hd }, { x: hw, y: hd }, c, sw);
    case 'exhaust_air_grille': return rect() + ln({ x: -hw, y: hd }, { x: hw, y: -hd }, c, sw);
    case 'sprinkler_head': { const rr = Math.max(r, 0.06); return circ(rr) + ln({ x: -rr * 1.5, y: 0 }, { x: rr * 1.5, y: 0 }, c, sw) + ln({ x: 0, y: -rr * 1.5 }, { x: 0, y: rr * 1.5 }, c, sw); }
    case 'light_fixture': return (Math.abs(w - d) < 1e-3 && w <= 0.35) ? circ() + ln({ x: -r * 0.7, y: -r * 0.7 }, { x: r * 0.7, y: r * 0.7 }, c, sw) + ln({ x: -r * 0.7, y: r * 0.7 }, { x: r * 0.7, y: -r * 0.7 }, c, sw) : rect() + X;
    case 'emergency_light': return rect() + `<polygon points="${f3(-hw)},${f3(-hd)} ${f3(hw)},${f3(-hd)} ${f3(hw)},${f3(hd)}" fill="${c}" />`;
    case 'power_outlet': return circ() + ln({ x: -r * 0.5, y: -r * 0.9 }, { x: -r * 0.5, y: r * 0.9 }, c, sw) + ln({ x: r * 0.5, y: -r * 0.9 }, { x: r * 0.5, y: r * 0.9 }, c, sw);
    case 'switch': return circ() + text(0, 0, null, r * 1.3, c, 'S', 700);
    case 'water_closet': return rect(-hw, -hd, w, d * 0.28) + `<ellipse cx="0" cy="${f3(d * 0.12)}" rx="${f3(hw * 0.8)}" ry="${f3(d * 0.36)}" ${fill} />`;
    case 'lavatory': case 'sink': return rect() + `<ellipse cx="0" cy="0" rx="${f3(hw * 0.7)}" ry="${f3(hd * 0.6)}" fill="none" stroke="${c}" stroke-width="${f3(sw)}" />`;
    case 'shower': return rect() + X;
    case 'floor_drain': return circ() + ln({ x: -r * 0.6, y: 0 }, { x: r * 0.6, y: 0 }, c, sw) + ln({ x: 0, y: -r * 0.6 }, { x: 0, y: r * 0.6 }, c, sw);
    default: return rect();
  }
}

function equipmentSvg(type: string, w: number, d: number, c: string): string {
  const hw = w / 2, hd = d / 2, r = Math.min(hw, hd) * 0.6, sw = Math.max(0.015, Math.min(0.03, Math.min(w, d) * 0.03));
  let s = `<rect x="${f3(-hw)}" y="${f3(-hd)}" width="${f3(w)}" height="${f3(d)}" fill="${c}" fill-opacity="0.15" stroke="${c}" stroke-width="${f3(sw)}" />`;
  if (type === 'pump' || type === 'fan' || type === 'cooling_tower') s += `<circle cx="0" cy="0" r="${f3(r)}" fill="none" stroke="${c}" stroke-width="${f3(sw)}" />`;
  if (type === 'pump') s += `<polygon points="${f3(-r * 0.5)},${f3(-r * 0.6)} ${f3(-r * 0.5)},${f3(r * 0.6)} ${f3(r * 0.7)},0" fill="${c}" fill-opacity="0.6" />`;
  if (type === 'panelboard') s += `<polygon points="${f3(-hw)},${f3(-hd)} ${f3(hw)},${f3(-hd)} ${f3(hw)},${f3(hd)}" fill="${c}" fill-opacity="0.55" />`;
  if (type === 'water_heater' || type === 'tank') s += `<circle cx="0" cy="0" r="${f3(Math.min(hw, hd) * 0.92)}" fill="none" stroke="${c}" stroke-width="${f3(sw)}" />`;
  return s;
}

/** Inline accessory symbol along +x, centred. */
function accessorySvg(kind: string, L: number, H: number, c: string): string {
  const hl = L / 2, hh = H / 2, sw = Math.max(0.012, Math.min(0.025, H * 0.06));
  const tri = (s: number, filled = false) => `<polygon points="${f3(s * hl)},${f3(-hh)} ${f3(s * hl)},${f3(hh)} 0,0" fill="${filled ? c : 'white'}" stroke="${c}" stroke-width="${f3(sw)}" />`;
  const bow = tri(-1) + tri(1);
  switch (kind) {
    case 'ball_valve': return bow + `<circle cx="0" cy="0" r="${f3(hh * 0.45)}" fill="${c}" />`;
    case 'globe_valve': return bow + `<circle cx="0" cy="0" r="${f3(hh * 0.45)}" fill="white" stroke="${c}" stroke-width="${f3(sw)}" />`;
    case 'butterfly_valve': return bow + ln({ x: 0, y: -hh * 1.2 }, { x: 0, y: hh * 1.2 }, c, sw * 1.4);
    case 'balancing_valve': return bow + ln({ x: -hl * 0.8, y: -hh * 1.1 }, { x: hl * 0.8, y: hh * 1.1 }, c, sw);
    case 'check_valve': return `<polygon points="${f3(-hl)},${f3(-hh)} ${f3(-hl)},${f3(hh)} ${f3(hl * 0.6)},0" fill="${c}" fill-opacity="0.75" stroke="${c}" stroke-width="${f3(sw)}" />` + ln({ x: hl * 0.6, y: -hh }, { x: hl * 0.6, y: hh }, c, sw * 1.4);
    case 'damper': return `<rect x="${f3(-hl)}" y="${f3(-hh)}" width="${f3(L)}" height="${f3(H)}" fill="white" stroke="${c}" stroke-width="${f3(sw)}" />` + ln({ x: -hl * 0.6, y: -hh * 0.85 }, { x: hl * 0.6, y: hh * 0.85 }, c, sw * 1.3);
    case 'fire_damper': return `<rect x="${f3(-hl)}" y="${f3(-hh)}" width="${f3(L)}" height="${f3(H)}" fill="white" stroke="${c}" stroke-width="${f3(sw)}" />` + ln({ x: -hl, y: -hh }, { x: hl, y: hh }, c, sw) + ln({ x: -hl, y: hh }, { x: hl, y: -hh }, c, sw) + text(0, hh + Math.max(0.12, H * 0.25), null, Math.max(0.12, Math.min(0.2, H * 0.35)), c, 'FD', 700);
    case 'flow_meter': return `<circle cx="0" cy="0" r="${f3(Math.max(hh, hl * 0.7))}" fill="white" stroke="${c}" stroke-width="${f3(sw)}" />` + text(0, 0, null, Math.max(hh, hl * 0.7), c, 'M', 700);
    case 'strainer': return ln({ x: -hl, y: 0 }, { x: hl, y: 0 }, c, sw) + ln({ x: -hl * 0.3, y: 0 }, { x: hl * 0.5, y: -hh }, c, sw);
    default: return bow;
  }
}
