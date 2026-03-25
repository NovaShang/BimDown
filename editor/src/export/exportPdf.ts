import type { ProjectData } from '../types.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { computeBounds } from '../model/elements.ts';
import { triggerDownload } from './download.ts';

// Color palette matching cli/src/render.ts
const COLORS: Record<string, { stroke: string; fill?: string }> = {
  wall:               { stroke: '#1a1a2e' },
  structure_wall:     { stroke: '#4a4e69' },
  column:             { stroke: '#2b2d42', fill: '#2b2d42' },
  structure_column:   { stroke: '#6c757d', fill: '#6c757d' },
  slab:               { stroke: '#adb5bd', fill: 'rgba(173,181,189,0.2)' },
  structure_slab:     { stroke: '#868e96', fill: 'rgba(134,142,150,0.2)' },
  space:              { stroke: '#3a86ff', fill: 'rgba(58,134,255,0.15)' },
  door:               { stroke: '#e63946' },
  window:             { stroke: '#2a9d8f' },
  stair:              { stroke: '#f4a261', fill: 'rgba(244,162,97,0.2)' },
  beam:               { stroke: '#9b5de5' },
  brace:              { stroke: '#9b5de5' },
  duct:               { stroke: '#00b4d8' },
  pipe:               { stroke: '#48bfe3' },
  cable_tray:         { stroke: '#90be6d' },
  conduit:            { stroke: '#43aa8b' },
  equipment:          { stroke: '#f94144', fill: 'rgba(249,65,68,0.15)' },
  terminal:           { stroke: '#f3722c', fill: 'rgba(243,114,44,0.15)' },
};

const DEFAULT_COLOR = { stroke: '#666' };

const RENDER_ORDER = [
  'slab', 'structure_slab', 'space',
  'wall', 'structure_wall', 'column', 'structure_column',
  'beam', 'brace', 'stair',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal',
  'door', 'window',
];

function r(n: number): string { return n.toFixed(3); }

function elementToSvgString(el: CanonicalElement, style: { stroke: string; fill?: string }): string {
  const fill = style.fill ?? 'none';
  switch (el.geometry) {
    case 'line':
    case 'spatial_line':
      return `<line x1="${r(el.start.x)}" y1="${r(-el.start.y)}" x2="${r(el.end.x)}" y2="${r(-el.end.y)}" stroke="${style.stroke}" stroke-width="${r(el.strokeWidth)}" stroke-linecap="round" fill="none"/>`;
    case 'point':
      return `<rect x="${r(el.position.x - el.width / 2)}" y="${r(-el.position.y - el.height / 2)}" width="${r(el.width)}" height="${r(el.height)}" stroke="${style.stroke}" fill="${fill}" stroke-width="0.05"/>`;
    case 'polygon': {
      const pts = el.vertices.map(v => `${r(v.x)},${r(-v.y)}`).join(' ');
      return `<polygon points="${pts}" stroke="${style.stroke}" fill="${fill}" stroke-width="0.05"/>`;
    }
  }
}

function buildFloorSvg(elements: CanonicalElement[]): { svg: string; width: number; height: number } | null {
  if (elements.length === 0) return null;

  // Group by table name
  const byTable = new Map<string, CanonicalElement[]>();
  for (const el of elements) {
    const list = byTable.get(el.tableName) ?? [];
    list.push(el);
    byTable.set(el.tableName, list);
  }

  const bounds = computeBounds(elements);
  if (!bounds) return null;

  // computeBounds returns { x, y (already negated), w, h }
  const margin = Math.max(bounds.w, bounds.h) * 0.05;
  const vbX = bounds.x - margin;
  const vbY = bounds.y - margin;
  const vbW = bounds.w + margin * 2;
  const vbH = bounds.h + margin * 2;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vbX)} ${r(vbY)} ${r(vbW)} ${r(vbH)}">`);

  // Render in order
  for (const tableName of RENDER_ORDER) {
    const els = byTable.get(tableName);
    if (!els) continue;
    const style = COLORS[tableName] ?? DEFAULT_COLOR;
    parts.push(`<g data-table="${tableName}">`);
    for (const el of els) {
      parts.push(elementToSvgString(el, style));
    }
    parts.push('</g>');
  }

  // Render any tables not in RENDER_ORDER
  for (const [tableName, els] of byTable) {
    if (RENDER_ORDER.includes(tableName)) continue;
    const style = COLORS[tableName] ?? DEFAULT_COLOR;
    parts.push(`<g data-table="${tableName}">`);
    for (const el of els) {
      parts.push(elementToSvgString(el, style));
    }
    parts.push('</g>');
  }

  parts.push('</svg>');
  return { svg: parts.join('\n'), width: vbW, height: vbH };
}

export async function exportPdf(project: ProjectData, modelName: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  await import('svg2pdf.js');

  // A3 landscape
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  const pageW = 420; // A3 landscape width mm
  const pageH = 297; // A3 landscape height mm
  const marginTop = 15;
  const marginBottom = 20;
  const marginLR = 15;
  const drawW = pageW - marginLR * 2;
  const drawH = pageH - marginTop - marginBottom;

  let isFirstPage = true;

  for (const level of project.levels) {
    const floor = project.floors.get(level.id);
    if (!floor) continue;

    const elements = parseFloorLayers(floor.layers);
    const result = buildFloorSvg(elements);
    if (!result) continue;

    if (!isFirstPage) pdf.addPage('a3', 'landscape');
    isFirstPage = false;

    // Title bar
    pdf.setFontSize(14);
    pdf.setTextColor(30, 30, 46);
    pdf.text(`${modelName} — ${level.name || level.id}`, marginLR, 10);
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text(`Elevation: ${level.elevation.toFixed(2)}m | ${new Date().toLocaleDateString()}`, pageW - marginLR, 10, { align: 'right' });

    // Draw border
    pdf.setDrawColor(200, 200, 200);
    pdf.rect(marginLR, marginTop, drawW, drawH);

    // Parse SVG and render to PDF
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(result.svg, 'image/svg+xml');
    const svgEl = svgDoc.documentElement;

    // Scale SVG to fit the drawing area
    const scaleX = drawW / result.width;
    const scaleY = drawH / result.height;
    const scale = Math.min(scaleX, scaleY) * 0.95;

    const scaledW = result.width * scale;
    const scaledH = result.height * scale;
    const offsetX = marginLR + (drawW - scaledW) / 2;
    const offsetY = marginTop + (drawH - scaledH) / 2;

    await (pdf as any).svg(svgEl, {
      x: offsetX,
      y: offsetY,
      width: scaledW,
      height: scaledH,
    });
  }

  if (isFirstPage) return; // No data

  const blob = pdf.output('blob');
  triggerDownload(blob, `${modelName}.pdf`);
}
