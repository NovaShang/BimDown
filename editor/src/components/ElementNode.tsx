import React from 'react';
import type { CanonicalElement } from '../model/elements.ts';
import { getRenderer } from '../renderers/index.ts';
import { processSvg, extractInnerSvg } from '../utils/processor.ts';
import { serializeToSvg, elementsToCsvRows } from '../model/serialize.ts';

/**
 * Per-element SVG HTML cache (fallback path only).
 * Used when no dedicated renderer is registered for a table type.
 */
const svgCache = new Map<string, { element: CanonicalElement; html: string }>();

function getElementHtml(element: CanonicalElement): string {
  const cached = svgCache.get(element.id);
  if (cached && cached.element === element) return cached.html;
  const svgString = serializeToSvg([element]);
  const csvRows = elementsToCsvRows([element]);
  const processed = processSvg(element.tableName, svgString, csvRows);
  const html = extractInnerSvg(processed);
  svgCache.set(element.id, { element, html });
  return html;
}

export function pruneCache(currentIds: Set<string>): void {
  for (const id of svgCache.keys()) {
    if (!currentIds.has(id)) svgCache.delete(id);
  }
}

interface ElementNodeProps {
  element: CanonicalElement;
}

/**
 * Renders a single canonical element.
 * Uses registered renderer if available, falls back to serialize→process pipeline.
 */
export const ElementNode = React.memo(function ElementNode({ element }: ElementNodeProps) {
  const render = getRenderer(element.tableName);
  if (render) {
    const result = render(element);
    if (result) return <g transform="scale(1,-1)">{result}</g>;
  }
  // Fallback: serialize→process→extractInnerSvg
  const html = getElementHtml(element);
  return <g dangerouslySetInnerHTML={{ __html: html }} />;
});
