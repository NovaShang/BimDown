import React from 'react';
import type { CanonicalElement } from '../model/elements.ts';
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

interface ElementNodeProps {
  element: CanonicalElement;
  viewBoxStr: string;
}

/**
 * Renders a single canonical element as processed SVG.
 * React.memo ensures this component only re-renders when the element
 * object reference changes (i.e., after a mutation in the reducer).
 */
export const ElementNode = React.memo(function ElementNode({ element, viewBoxStr }: ElementNodeProps) {
  const html = getElementHtml(element, viewBoxStr);
  return <g dangerouslySetInnerHTML={{ __html: html }} />;
});
