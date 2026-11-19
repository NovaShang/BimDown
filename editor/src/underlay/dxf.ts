// DXF → a flat vector drawing for underlay display and snapping. Parsing is
// done by `dxf-parser`; this module flattens blocks (INSERT, DIMENSION),
// tessellates arcs / circles / ellipses / bulges / splines into polylines and
// keeps single-line text. Coordinates are stored relative to `origin` (the
// drawing's bounds center) so survey-sized coordinates stay precise in SVG.

import DxfParser from 'dxf-parser';
import type { IDxf, IEntity, IPoint } from 'dxf-parser';
import type { Bounds } from './transform.ts';

export interface DxfLayerInfo {
  name: string;
  /** CSS color for display */
  color: string;
  /** Off or frozen in the file */
  offInFile: boolean;
  /** Polylines + texts on the layer */
  count: number;
}

export interface DxfText {
  layer: string;
  x: number;
  y: number;
  height: number;
  /** Degrees, counter-clockwise */
  rotation: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'auto' | 'middle' | 'hanging';
}

export interface DxfDrawing {
  layers: DxfLayerInfo[];
  /** Per layer, polylines as flat [x0, y0, x1, y1, …] relative to `origin` */
  polylines: Map<string, number[][]>;
  texts: DxfText[];
  /** Add to every stored coordinate to get DXF drawing coordinates */
  origin: { x: number; y: number };
  /** In DXF drawing coordinates */
  bounds: Bounds;
  /** $INSUNITS (0 = unitless) */
  insUnits: number;
  segmentCount: number;
}

// ── Decoding ──

const CODEPAGES: Record<string, string> = {
  ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_932: 'shift_jis', ANSI_949: 'euc-kr',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
  ANSI_874: 'windows-874',
};

/** DXF bytes → text: UTF-8 (R2007+), else the file's $DWGCODEPAGE. */
export function decodeDxf(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 64 * 1024));
    const m = head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/i);
    const label = m ? CODEPAGES[m[1].toUpperCase()] : undefined;
    try {
      return new TextDecoder(label ?? 'windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

// ── Geometry helpers ──

/** 2D affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Arbitrary-axis OCS with extrusion (0,0,-1) mirrors X; other tilts are ignored. */
function ocs(e: Record<string, unknown>): Mat {
  const z = (e.extrusionDirectionZ as number | undefined) ?? (e.extrusionDirection as IPoint | undefined)?.z ?? 1;
  return z < 0 ? [-1, 0, 0, 1, 0, 0] : IDENTITY;
}

const MAX_SEG_ANGLE = Math.PI / 18; // 10°

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): number[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil(sweep / MAX_SEG_ANGLE));
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

/** Points of a polyline with bulges (arc segments), flat. */
function bulgePolyline(vertices: { x: number; y: number; bulge?: number }[], closed: boolean): number[] {
  const out: number[] = [];
  const n = vertices.length;
  const segs = closed ? n : n - 1;
  if (n === 0) return out;
  out.push(vertices[0].x, vertices[0].y);
  for (let i = 0; i < segs; i++) {
    const p = vertices[i], q = vertices[(i + 1) % n];
    const b = p.bulge ?? 0;
    if (Math.abs(b) < 1e-9) {
      out.push(q.x, q.y);
      continue;
    }
    // Arc with included angle θ = 4·atan(b); positive bulge = counter-clockwise.
    const theta = 4 * Math.atan(b);
    const dx = q.x - p.x, dy = q.y - p.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const h = r * Math.cos(Math.abs(theta) / 2); // center distance from chord midpoint
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const sign = b > 0 ? 1 : -1;
    const cx = mx - sign * (dy / chord) * h;
    const cy = my + sign * (dx / chord) * h;
    const a0 = Math.atan2(p.y - cy, p.x - cx);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / MAX_SEG_ANGLE));
    for (let k = 1; k <= steps; k++) {
      const a = a0 + (theta * k) / steps;
      out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  return out;
}

/** Non-rational B-spline evaluation (de Boor); falls back to the control polygon. */
function splinePoints(ctrl: IPoint[], knots: number[], degree: number): number[] {
  const n = ctrl.length;
  if (n < 2 || degree < 1 || knots.length !== n + degree + 1) return ctrl.flatMap(p => [p.x, p.y]);
  const t0 = knots[degree], t1 = knots[n];
  const steps = Math.min(400, Math.max(8, n * 8));
  const out: number[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = Math.min(t0 + ((t1 - t0) * s) / steps, t1 - 1e-12 * Math.max(1, Math.abs(t1)));
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) d.push({ x: ctrl[k - degree + j].x, y: ctrl[k - degree + j].y });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    out.push(d[degree].x, d[degree].y);
  }
  return out;
}

/** Strip MTEXT inline formatting; `\P` becomes a line break. */
export function plainMtext(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQTtWw][^;\\]*;/g, '')
    .replace(/\\S([^;]*)[#^/]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, '⌀').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
}

function aciToCss(color: number | undefined, colorIndex: number | undefined): string {
  // White/black (7) and greys read best as near-black on a light canvas.
  if (colorIndex === 7 || colorIndex === undefined || color === undefined) return '#3f3f46';
  let r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
  // CAD colors are picked for a black background: darken light ones (yellow,
  // cyan, light greys) until they read on the light plan canvas.
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.55) {
    const k = 0.55 / lum;
    r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
  }
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── Flattening ──

interface Sink {
  polylines: Map<string, number[][]>;
  texts: DxfText[];
}

const MAX_BLOCK_DEPTH = 8;
const MAX_ARRAY = 400;

function addPolyline(sink: Sink, layer: string, m: Mat, flat: number[], closed = false) {
  if (flat.length < 4) return;
  const out: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const [x, y] = apply(m, flat[i], flat[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    out.push(x, y);
  }
  if (closed && (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1])) out.push(out[0], out[1]);
  let list = sink.polylines.get(layer);
  if (!list) sink.polylines.set(layer, list = []);
  list.push(out);
}

function addText(sink: Sink, layer: string, m: Mat, x: number, y: number, height: number, rotDeg: number,
  text: string, anchor: DxfText['anchor'], baseline: DxfText['baseline']) {
  if (!text.trim() || !(height > 0)) return;
  const [tx, ty] = apply(m, x, y);
  // Scale and rotation picked up from the block transform
  const sx = Math.hypot(m[0], m[1]);
  const rot = rotDeg + Math.atan2(m[1], m[0]) * 180 / Math.PI;
  sink.texts.push({ layer, x: tx, y: ty, height: height * sx, rotation: rot, text, anchor, baseline });
}

type AnyEntity = IEntity & Record<string, unknown>;

function flatten(dxf: IDxf, entities: IEntity[], m: Mat, sink: Sink, parentLayer: string | null, depth: number) {
  for (const raw of entities) {
    const e = raw as AnyEntity;
    if (e.inPaperSpace) continue;
    // Entities on layer "0" inside a block take the INSERT's layer.
    const layer = (e.layer === '0' || !e.layer) && parentLayer ? parentLayer : (e.layer || '0');
    const em = mul(m, ocs(e));
    switch (e.type) {
      case 'LINE': {
        const v = e.vertices as IPoint[] | undefined;
        if (v && v.length >= 2) addPolyline(sink, layer, m, [v[0].x, v[0].y, v[1].x, v[1].y]);
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        if (e.isPolyfaceMesh || e.is3dPolygonMesh) break;
        const v = (e.vertices as { x: number; y: number; bulge?: number }[] | undefined) ?? [];
        addPolyline(sink, layer, em, bulgePolyline(v, !!e.shape), false);
        break;
      }
      case 'ARC': {
        const c = e.center as IPoint;
        addPolyline(sink, layer, em, arcPoints(c.x, c.y, e.radius as number, e.startAngle as number, e.endAngle as number));
        break;
      }
      case 'CIRCLE': {
        const c = e.center as IPoint;
        addPolyline(sink, layer, em, arcPoints(c.x, c.y, e.radius as number, 0, Math.PI * 2));
        break;
      }
      case 'ELLIPSE': {
        const c = e.center as IPoint, maj = e.majorAxisEndPoint as IPoint;
        const ratio = e.axisRatio as number;
        const a0 = (e.startAngle as number) ?? 0;
        let a1 = (e.endAngle as number) ?? Math.PI * 2;
        if (a1 <= a0) a1 += Math.PI * 2;
        const n = Math.max(8, Math.ceil((a1 - a0) / MAX_SEG_ANGLE));
        const pts: number[] = [];
        for (let i = 0; i <= n; i++) {
          const t = a0 + ((a1 - a0) * i) / n;
          const ct = Math.cos(t), st = Math.sin(t);
          pts.push(c.x + maj.x * ct - maj.y * ratio * st, c.y + maj.y * ct + maj.x * ratio * st);
        }
        addPolyline(sink, layer, em, pts);
        break;
      }
      case 'SPLINE': {
        const fit = e.fitPoints as IPoint[] | undefined;
        const ctrl = e.controlPoints as IPoint[] | undefined;
        const pts = fit && fit.length >= 2
          ? fit.flatMap(p => [p.x, p.y])
          : ctrl ? splinePoints(ctrl, (e.knotValues as number[]) ?? [], (e.degreeOfSplineCurve as number) ?? 3) : [];
        addPolyline(sink, layer, em, pts, !!e.closed);
        break;
      }
      case 'SOLID':
      case '3DFACE': {
        const v = (e.points ?? e.vertices) as IPoint[] | undefined;
        if (!v || v.length < 3) break;
        // SOLID stores corners in Z order (1, 2, 4, 3)
        const order = e.type === 'SOLID' && v.length === 4 ? [v[0], v[1], v[3], v[2]] : v;
        addPolyline(sink, layer, em, order.flatMap(p => [p.x, p.y]), true);
        break;
      }
      case 'TEXT': {
        const h = e.textHeight as number;
        const halign = (e.halign as number) ?? 0, valign = (e.valign as number) ?? 0;
        const useEnd = (halign !== 0 || valign !== 0) && e.endPoint;
        const p = (useEnd ? e.endPoint : e.startPoint) as IPoint | undefined;
        if (!p) break;
        const anchor = halign === 1 || halign === 4 ? 'middle' : halign === 2 ? 'end' : 'start';
        const baseline = valign === 3 ? 'hanging' : valign === 2 || halign === 4 ? 'middle' : 'auto';
        addText(sink, layer, em, p.x, p.y, h, (e.rotation as number) ?? 0, String(e.text ?? ''), anchor, baseline);
        break;
      }
      case 'MTEXT': {
        const p = e.position as IPoint | undefined;
        if (!p) break;
        const lines = plainMtext(String(e.text ?? '')).split('\n');
        const h = (e.height as number) ?? 0;
        const att = (e.attachmentPoint as number) ?? 1;
        const col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
        const anchor = col === 0 ? 'start' : col === 1 ? 'middle' : 'end';
        let rot = (e.rotation as number) ?? 0;
        const dir = e.directionVector as IPoint | undefined;
        if (dir && (dir.x || dir.y)) rot = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
        const lineGap = h * 1.5;
        const total = (lines.length - 1) * lineGap;
        // Baseline of the first line, measured down from the attachment point
        const firstDown = row === 0 ? h : row === 1 ? h / 2 - total / 2 : -total;
        const c = Math.cos(rot * Math.PI / 180), s = Math.sin(rot * Math.PI / 180);
        lines.forEach((line, i) => {
          const down = firstDown + i * lineGap;
          addText(sink, layer, em, p.x + s * down, p.y - c * down, h, rot, line, anchor, 'auto');
        });
        break;
      }
      case 'INSERT':
      case 'DIMENSION': {
        if (depth >= MAX_BLOCK_DEPTH) break;
        const name = (e.type === 'INSERT' ? e.name : e.block) as string | undefined;
        const block = name ? dxf.blocks?.[name] : undefined;
        if (!block?.entities?.length) break;
        const base = block.position ?? { x: 0, y: 0, z: 0 };
        if (e.type === 'DIMENSION') {
          // Dimension blocks are already in world coordinates.
          flatten(dxf, block.entities, m, sink, layer, depth + 1);
          break;
        }
        const pos = (e.position as IPoint) ?? { x: 0, y: 0, z: 0 };
        const sx = (e.xScale as number) ?? 1, sy = (e.yScale as number) ?? 1;
        const rot = (((e.rotation as number) ?? 0) * Math.PI) / 180;
        const cols = Math.min(MAX_ARRAY, Math.max(1, (e.columnCount as number) ?? 1));
        const rows = Math.min(MAX_ARRAY, Math.max(1, (e.rowCount as number) ?? 1));
        const cs = (e.columnSpacing as number) ?? 0, rs = (e.rowSpacing as number) ?? 0;
        const c = Math.cos(rot), s = Math.sin(rot);
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) {
            const ox = j * cs, oy = i * rs; // array offsets, in the rotated frame
            const local: Mat = mul(
              [c * sx, s * sx, -s * sy, c * sy, pos.x + c * ox - s * oy, pos.y + s * ox + c * oy],
              [1, 0, 0, 1, -base.x, -base.y],
            );
            flatten(dxf, block.entities, mul(em, local), sink, layer, depth + 1);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Parse DXF text. Throws on files dxf-parser can't read. */
export function parseDxf(text: string): DxfDrawing {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Not a DXF file');
  const sink: Sink = { polylines: new Map(), texts: [] };
  flatten(dxf, dxf.entities ?? [], IDENTITY, sink, null, 0);

  // Bounds over geometry (text insertion points only when there's no geometry)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let segmentCount = 0;
  for (const list of sink.polylines.values()) {
    for (const pl of list) {
      segmentCount += pl.length / 2 - 1;
      for (let i = 0; i < pl.length; i += 2) {
        if (pl[i] < minX) minX = pl[i];
        if (pl[i] > maxX) maxX = pl[i];
        if (pl[i + 1] < minY) minY = pl[i + 1];
        if (pl[i + 1] > maxY) maxY = pl[i + 1];
      }
    }
  }
  if (minX === Infinity) {
    for (const t of sink.texts) {
      minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
      minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y);
    }
  }
  if (minX === Infinity) throw new Error('The DXF has no supported geometry');
  const bounds = { minX, minY, maxX, maxY };

  // Re-center stored coordinates on a rounded bounds center.
  const round = (v: number) => {
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(v) || 1)) - 2);
    return Math.round(v / mag) * mag;
  };
  const origin = { x: round((minX + maxX) / 2), y: round((minY + maxY) / 2) };
  for (const list of sink.polylines.values()) {
    for (const pl of list) {
      for (let i = 0; i < pl.length; i += 2) { pl[i] -= origin.x; pl[i + 1] -= origin.y; }
    }
  }
  for (const t of sink.texts) { t.x -= origin.x; t.y -= origin.y; }

  // Layers: the file's table, in file order, plus any used but undeclared
  const table = dxf.tables?.layer?.layers ?? {};
  const counts = new Map<string, number>();
  for (const [name, list] of sink.polylines) counts.set(name, (counts.get(name) ?? 0) + list.length);
  for (const t of sink.texts) counts.set(t.layer, (counts.get(t.layer) ?? 0) + 1);
  const names = [...new Set([...Object.keys(table), ...counts.keys()])].filter(n => counts.has(n));
  const layers: DxfLayerInfo[] = names.map(name => {
    const l = table[name];
    return {
      name,
      color: aciToCss(l?.color, l?.colorIndex),
      offInFile: !!l && (l.visible === false || l.frozen === true),
      count: counts.get(name) ?? 0,
    };
  });

  const insUnits = Number(dxf.header?.$INSUNITS ?? 0) || 0;
  return { layers, polylines: sink.polylines, texts: sink.texts, origin, bounds, insUnits, segmentCount };
}
