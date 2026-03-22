import React from 'react';
import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { processSvg, extractInnerSvg } from '../utils/processor.ts';
import { serializeToSvg, elementsToCsvRows } from '../model/serialize.ts';

/**
 * Per-element SVG HTML cache.
 * Key: element.id
 * Value: { element reference, processed HTML string }
 *
 * We use referential equality: if the element object hasn't changed,
 * the cached HTML is still valid. On mutation, the reducer creates a
 * new object, so === will fail and we re-process just that one element.
 */
const svgCache = new Map<string, { element: CanonicalElement; html: string }>();

function getElementHtml(element: CanonicalElement, viewBoxStr: string): string {
  const cached = svgCache.get(element.id);
  if (cached && cached.element === element) {
    return cached.html;
  }
  // Process this single element through the full pipeline
  const svgString = serializeToSvg([element], viewBoxStr);
  const csvRows = elementsToCsvRows([element]);
  const processed = processSvg(element.tableName, svgString, csvRows);
  const html = extractInnerSvg(processed);
  svgCache.set(element.id, { element, html });
  return html;
}

/** Evict stale cache entries for elements that no longer exist */
export function pruneCache(currentIds: Set<string>): void {
  for (const id of svgCache.keys()) {
    if (!currentIds.has(id)) svgCache.delete(id);
  }
}

// Tables whose outlines are rendered by WallOutlines — only need fill here
const FILL_ONLY_TABLES = new Set([
  'wall', 'structure_wall', 'duct', 'pipe', 'conduit', 'cable_tray',
]);

const WALL_FILL: Record<string, (material: string) => string> = {
  wall: (m) => m.includes('concrete') ? '#d4d4d4' : m.includes('metal') || m.includes('steel') ? '#e8e8e8' : '#f0f0f0',
  structure_wall: (m) => m.includes('concrete') ? '#d4d4d4' : '#e8e8e8',
  duct: () => '#00b4d815',
  pipe: () => '#06d6a015',
  conduit: () => '#ffd16615',
  cable_tray: () => '#ffd16615',
};

interface ElementNodeProps {
  element: CanonicalElement;
  viewBoxStr: string;
}

/**
 * Renders a single canonical element as processed SVG.
 * Wall/MEP line elements render fill-only polygons (outlines handled by WallOutlines).
 * Other elements go through the full serialize→process pipeline.
 */
export const ElementNode = React.memo(function ElementNode({ element, viewBoxStr }: ElementNodeProps) {
  if (element.geometry === 'line' && FILL_ONLY_TABLES.has(element.tableName)) {
    return <LineFillNode element={element as LineElement} />;
  }
  const html = getElementHtml(element, viewBoxStr);
  return <g dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Fill-only polygon for wall/MEP line elements. No stroke — outlines are in WallOutlines. */
const LineFillNode = React.memo(function LineFillNode({ element }: { element: LineElement }) {
  const { start, end, strokeWidth, id, tableName, attrs } = element;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const ux = dx / len, uy = dy / len;       // unit direction
  const nx = -uy, ny = ux;                   // perpendicular normal
  const hw = strokeWidth / 2;
  const ext = 0.01;                          // tiny extension to prevent gaps under outline

  // 4 corners with small extension along wall direction
  const p1 = `${start.x + nx * hw - ux * ext},${start.y + ny * hw - uy * ext}`;
  const p2 = `${end.x + nx * hw + ux * ext},${end.y + ny * hw + uy * ext}`;
  const p3 = `${end.x - nx * hw + ux * ext},${end.y - ny * hw + uy * ext}`;
  const p4 = `${start.x - nx * hw - ux * ext},${start.y - ny * hw - uy * ext}`;

  const material = (attrs.material ?? '').toLowerCase();
  const getFill = WALL_FILL[tableName];
  const fill = getFill ? getFill(material) : '#eee';

  return (
    <g transform="scale(1,-1)">
      <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill={fill} stroke="none" data-id={id} />
    </g>
  );
});
