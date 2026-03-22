import type { CsvRow } from '../types.ts';
import { computeCornerAdjustments, type WallSegment } from './wallMiter.ts';
import { parsePoints } from '../model/parse.ts';

const parser = new DOMParser();
const serializer = new XMLSerializer();

function parseSvg(svgString: string): Document {
  return parser.parseFromString(svgString, 'image/svg+xml');
}

export function extractViewBox(svgString: string): { x: number; y: number; w: number; h: number } | null {
  const match = svgString.match(/viewBox="([^"]+)"/);
  if (!match) return null;
  const parts = match[1].split(/\s+/).map(Number);
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function transformWalls(svgString: string, csvRows: Map<string, CsvRow>): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const lines = Array.from(g.querySelectorAll('line'));

  // Pass 1: collect wall data
  interface WallData {
    id: string; x1: number; y1: number; x2: number; y2: number;
    halfW: number; nx: number; ny: number; fillColor: string; lineEl: Element;
  }
  const wallData: WallData[] = [];
  const miterSegments: WallSegment[] = [];

  for (const line of lines) {
    const id = line.getAttribute('id') || '';
    const x1 = parseFloat(line.getAttribute('x1') || '0');
    const y1 = parseFloat(line.getAttribute('y1') || '0');
    const x2 = parseFloat(line.getAttribute('x2') || '0');
    const y2 = parseFloat(line.getAttribute('y2') || '0');
    const strokeWidth = parseFloat(line.getAttribute('stroke-width') || '0.1');

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) {
      line.setAttribute('stroke', '#555');
      line.setAttribute('stroke-width', '0.03');
      continue;
    }

    const nx = -dy / len;
    const ny = dx / len;
    const halfW = strokeWidth / 2;

    const csv = csvRows.get(id);
    const material = csv?.material?.toLowerCase() || '';
    let fillColor = 'none';
    if (material.includes('concrete')) {
      fillColor = '#d4d4d4';
    } else if (material.includes('metal') || material.includes('steel')) {
      fillColor = '#e8e8e8';
    }

    miterSegments.push({ id, x1, y1, x2, y2, halfWidth: halfW, fill: fillColor });
    wallData.push({ id, x1, y1, x2, y2, halfW, nx, ny, fillColor, lineEl: line });
  }

  // Compute miter corner adjustments
  const { adjustments: adj } = computeCornerAdjustments(miterSegments);

  // Pass 2: build adjusted SVG elements
  const newElements: Element[] = [];
  for (const w of wallData) {
    const { id, x1, y1, x2, y2, halfW, nx, ny, fillColor, lineEl } = w;

    // Default perpendicular corners
    let p1x = x1 + nx * halfW, p1y = y1 + ny * halfW; // start +normal
    let p2x = x2 + nx * halfW, p2y = y2 + ny * halfW; // end +normal
    let p3x = x2 - nx * halfW, p3y = y2 - ny * halfW; // end -normal
    let p4x = x1 - nx * halfW, p4y = y1 - ny * halfW; // start -normal

    // Apply miter adjustments
    const startAdj = adj.get(`${id}:start`);
    if (startAdj) {
      p1x = startAdj.left.x;  p1y = startAdj.left.y;   // +normal side
      p4x = startAdj.right.x; p4y = startAdj.right.y;   // -normal side
    }
    const endAdj = adj.get(`${id}:end`);
    if (endAdj) {
      p2x = endAdj.right.x; p2y = endAdj.right.y;  // +normal of wall = right in end-away coords
      p3x = endAdj.left.x;  p3y = endAdj.left.y;   // -normal of wall = left in end-away coords
    }

    const poly = doc.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points',
      `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y} ${p4x},${p4y}`);
    poly.setAttribute('fill', fillColor);
    poly.setAttribute('stroke', 'none');
    poly.setAttribute('data-id', id);

    const line1 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', String(p1x));
    line1.setAttribute('y1', String(p1y));
    line1.setAttribute('x2', String(p2x));
    line1.setAttribute('y2', String(p2y));
    line1.setAttribute('stroke', '#1a1a2e');
    line1.setAttribute('stroke-width', '0.03');
    line1.setAttribute('data-id', id);

    const line2 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', String(p4x));
    line2.setAttribute('y1', String(p4y));
    line2.setAttribute('x2', String(p3x));
    line2.setAttribute('y2', String(p3y));
    line2.setAttribute('stroke', '#1a1a2e');
    line2.setAttribute('stroke-width', '0.03');
    line2.setAttribute('data-id', id);

    newElements.push(poly, line1, line2);
    lineEl.remove();
  }

  for (const el of newElements) {
    g.appendChild(el);
  }

  return serializer.serializeToString(doc);
}

function transformSpaces(svgString: string, csvRows: Map<string, CsvRow>): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const polygons = Array.from(g.querySelectorAll('polygon'));

  for (const poly of polygons) {
    const id = poly.getAttribute('id') || '';
    const csv = csvRows.get(id);

    poly.setAttribute('fill', 'rgba(58, 134, 255, 0.06)');
    poly.setAttribute('stroke', '#3a86ff');
    poly.setAttribute('stroke-width', '0.03');
    poly.setAttribute('stroke-dasharray', '0.15,0.08');
    poly.setAttribute('data-id', id);

    const points = parsePoints(poly.getAttribute('points') || '');
    if (points.length === 0) continue;

    const centroid = calculateCentroid(points);

    const number = csv?.number || '';
    const name = csv?.name || '';
    if (number || name) {
      if (number) {
        const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(centroid.x));
        text.setAttribute('y', String(-centroid.y));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('font-size', '0.4');
        text.setAttribute('font-family', 'Inter, sans-serif');
        text.setAttribute('font-weight', '700');
        text.setAttribute('fill', '#1e3a5f');
        text.setAttribute('transform', `scale(1,-1) translate(0, ${-2 * centroid.y})`);
        text.textContent = number;
        g.appendChild(text);
      }

      if (name) {
        const nameText = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
        nameText.setAttribute('x', String(centroid.x));
        nameText.setAttribute('y', String(-centroid.y + 0.45));
        nameText.setAttribute('text-anchor', 'middle');
        nameText.setAttribute('dominant-baseline', 'central');
        nameText.setAttribute('font-size', '0.22');
        nameText.setAttribute('font-family', 'Inter, sans-serif');
        nameText.setAttribute('font-weight', '400');
        nameText.setAttribute('fill', '#4a6fa5');
        nameText.setAttribute('transform', `scale(1,-1) translate(0, ${-2 * centroid.y + 0.9})`);
        nameText.textContent = name;
        g.appendChild(nameText);
      }
    }
  }

  return serializer.serializeToString(doc);
}

function transformDoors(svgString: string, csvRows: Map<string, CsvRow>): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const lines = Array.from(g.querySelectorAll('line'));

  for (const line of lines) {
    const id = line.getAttribute('id') || '';
    const csv = csvRows.get(id);
    const x1 = parseFloat(line.getAttribute('x1') || '0');
    const y1 = parseFloat(line.getAttribute('y1') || '0');
    const strokeWidth = parseFloat(line.getAttribute('stroke-width') || '0.3');

    const halfW = strokeWidth / 2;
    const operation = csv?.operation || 'single_swing';

    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x1 - halfW));
    rect.setAttribute('y', String(y1 - 0.025));
    rect.setAttribute('width', String(strokeWidth));
    rect.setAttribute('height', '0.05');
    rect.setAttribute('fill', '#0077b6');
    rect.setAttribute('data-id', id);

    if (operation.includes('swing')) {
      const arc = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      const r = halfW;
      const d = `M ${x1 - r},${y1} A ${r},${r} 0 0 1 ${x1},${y1 + r}`;
      arc.setAttribute('d', d);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', '#0077b6');
      arc.setAttribute('stroke-width', '0.02');
      arc.setAttribute('stroke-dasharray', '0.06,0.04');
      arc.setAttribute('data-id', id);
      g.appendChild(arc);
    }

    g.appendChild(rect);
    line.remove();
  }

  return serializer.serializeToString(doc);
}

function transformColumns(svgString: string, _csvRows: Map<string, CsvRow>, isStructural: boolean): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const rects = Array.from(g.querySelectorAll('rect'));

  for (const rect of rects) {
    const id = rect.getAttribute('id') || '';
    const x = parseFloat(rect.getAttribute('x') || '0');
    const y = parseFloat(rect.getAttribute('y') || '0');
    const w = parseFloat(rect.getAttribute('width') || '0');
    const h = parseFloat(rect.getAttribute('height') || '0');

    const color = isStructural ? '#6d4c41' : '#333';

    rect.setAttribute('fill', isStructural ? '#d7ccc8' : '#e0e0e0');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '0.02');
    rect.setAttribute('data-id', id);

    const line1 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', String(x));
    line1.setAttribute('y1', String(y));
    line1.setAttribute('x2', String(x + w));
    line1.setAttribute('y2', String(y + h));
    line1.setAttribute('stroke', color);
    line1.setAttribute('stroke-width', '0.015');
    line1.setAttribute('data-id', id);

    const line2 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', String(x + w));
    line2.setAttribute('y1', String(y));
    line2.setAttribute('x2', String(x));
    line2.setAttribute('y2', String(y + h));
    line2.setAttribute('stroke', color);
    line2.setAttribute('stroke-width', '0.015');
    line2.setAttribute('data-id', id);

    g.appendChild(line1);
    g.appendChild(line2);
  }

  return serializer.serializeToString(doc);
}

function transformSlabs(svgString: string, _csvRows: Map<string, CsvRow>, isStructural: boolean): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const polygons = Array.from(g.querySelectorAll('polygon'));

  for (const poly of polygons) {
    const id = poly.getAttribute('id') || '';
    poly.setAttribute('fill', isStructural ? 'rgba(141,110,99,0.08)' : 'rgba(128,128,128,0.06)');
    poly.setAttribute('stroke', isStructural ? '#8d6e63' : '#9e9e9e');
    poly.setAttribute('stroke-width', '0.02');
    poly.setAttribute('data-id', id);
  }

  return serializer.serializeToString(doc);
}

function transformMepLines(svgString: string, _csvRows: Map<string, CsvRow>, type: 'duct' | 'pipe'): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const color = type === 'duct' ? '#00b4d8' : '#06d6a0';
  const lines = Array.from(g.querySelectorAll('line'));

  // Pass 1: collect MEP line data
  interface MepData {
    id: string; x1: number; y1: number; x2: number; y2: number;
    halfW: number; nx: number; ny: number; lineEl: Element;
  }
  const mepData: MepData[] = [];
  const miterSegments: WallSegment[] = [];

  for (const line of lines) {
    const id = line.getAttribute('id') || '';
    const x1 = parseFloat(line.getAttribute('x1') || '0');
    const y1 = parseFloat(line.getAttribute('y1') || '0');
    const x2 = parseFloat(line.getAttribute('x2') || '0');
    const y2 = parseFloat(line.getAttribute('y2') || '0');
    const strokeWidth = parseFloat(line.getAttribute('stroke-width') || '0.1');

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) continue;

    const nx = -dy / len;
    const ny = dx / len;
    const halfW = strokeWidth / 2;

    miterSegments.push({ id, x1, y1, x2, y2, halfWidth: halfW, fill: color + '15' });
    mepData.push({ id, x1, y1, x2, y2, halfW, nx, ny, lineEl: line });
  }

  const { adjustments: adj } = computeCornerAdjustments(miterSegments);

  // Pass 2: build adjusted SVG elements
  const newElements: Element[] = [];
  for (const m of mepData) {
    const { id, x1, y1, x2, y2, halfW, nx, ny, lineEl } = m;

    let p1x = x1 + nx * halfW, p1y = y1 + ny * halfW;
    let p2x = x2 + nx * halfW, p2y = y2 + ny * halfW;
    let p3x = x2 - nx * halfW, p3y = y2 - ny * halfW;
    let p4x = x1 - nx * halfW, p4y = y1 - ny * halfW;

    const startAdj = adj.get(`${id}:start`);
    if (startAdj) {
      p1x = startAdj.left.x;  p1y = startAdj.left.y;
      p4x = startAdj.right.x; p4y = startAdj.right.y;
    }
    const endAdj = adj.get(`${id}:end`);
    if (endAdj) {
      p2x = endAdj.right.x; p2y = endAdj.right.y;
      p3x = endAdj.left.x;  p3y = endAdj.left.y;
    }

    const poly = doc.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points',
      `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y} ${p4x},${p4y}`);
    poly.setAttribute('fill', color + '15');
    poly.setAttribute('stroke', 'none');
    poly.setAttribute('data-id', id);

    const line1 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', String(p1x));
    line1.setAttribute('y1', String(p1y));
    line1.setAttribute('x2', String(p2x));
    line1.setAttribute('y2', String(p2y));
    line1.setAttribute('stroke', color);
    line1.setAttribute('stroke-width', '0.025');
    line1.setAttribute('data-id', id);

    const line2 = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', String(p4x));
    line2.setAttribute('y1', String(p4y));
    line2.setAttribute('x2', String(p3x));
    line2.setAttribute('y2', String(p3y));
    line2.setAttribute('stroke', color);
    line2.setAttribute('stroke-width', '0.025');
    line2.setAttribute('data-id', id);

    newElements.push(poly, line1, line2);
    lineEl.remove();
  }

  for (const el of newElements) {
    g.appendChild(el);
  }

  return serializer.serializeToString(doc);
}

function transformEquipment(svgString: string, _csvRows: Map<string, CsvRow>, type: 'terminal' | 'equipment'): string {
  const doc = parseSvg(svgString);
  const g = doc.querySelector('g');
  if (!g) return svgString;

  const color = type === 'terminal' ? '#f77f00' : '#e63946';
  const rects = Array.from(g.querySelectorAll('rect'));

  for (const rect of rects) {
    const id = rect.getAttribute('id') || '';
    rect.setAttribute('fill', color + '30');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '0.02');
    rect.setAttribute('rx', '0.03');
    rect.setAttribute('ry', '0.03');
    rect.setAttribute('data-id', id);
  }

  return serializer.serializeToString(doc);
}

export function processSvg(
  tableName: string,
  svgContent: string,
  csvRows: Map<string, CsvRow>,
): string {
  switch (tableName) {
    case 'wall':
    case 'structure_wall':
      return transformWalls(svgContent, csvRows);
    case 'space':
      return transformSpaces(svgContent, csvRows);
    case 'door':
      return transformDoors(svgContent, csvRows);
    case 'column':
      return transformColumns(svgContent, csvRows, false);
    case 'structure_column':
      return transformColumns(svgContent, csvRows, true);
    case 'slab':
      return transformSlabs(svgContent, csvRows, false);
    case 'structure_slab':
      return transformSlabs(svgContent, csvRows, true);
    case 'duct':
      return transformMepLines(svgContent, csvRows, 'duct');
    case 'pipe':
      return transformMepLines(svgContent, csvRows, 'pipe');
    case 'terminal':
      return transformEquipment(svgContent, csvRows, 'terminal');
    case 'equipment':
      return transformEquipment(svgContent, csvRows, 'equipment');
    default:
      return svgContent;
  }
}

export function extractInnerSvg(svgString: string): string {
  const gMatch = svgString.match(/<g[^>]*>([\s\S]*?)<\/g>/);
  if (gMatch) {
    return `<g transform="scale(1,-1)">${gMatch[1]}</g>`;
  }
  return '';
}


function calculateCentroid(points: { x: number; y: number }[]): { x: number; y: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const cross = points[i].x * points[j].y - points[j].x * points[i].y;
    area += cross;
    cx += (points[i].x + points[j].x) * cross;
    cy += (points[i].y + points[j].y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10) {
    const sx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const sy = points.reduce((s, p) => s + p.y, 0) / points.length;
    return { x: sx, y: sy };
  }
  cx /= (6 * area);
  cy /= (6 * area);
  return { x: cx, y: cy };
}
