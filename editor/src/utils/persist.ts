import type { DocumentState } from '../model/document.ts';
import { groupByLayer, serializeToSvg, serializeToCsv } from '../model/serialize.ts';

/**
 * Persist document state to disk via Vite middleware.
 * Serializes all layers to CSV + SVG and POSTs to /api/save.
 */
export async function persistDocument(doc: DocumentState, viewBox: string): Promise<void> {
  const elements = Array.from(doc.elements.values());
  const groups = groupByLayer(elements);

  const files: { path: string; content: string }[] = [];

  for (const [key, groupElements] of groups) {
    const [discipline, tableName] = key.split('/');
    const levelId = doc.levelId;

    // SVG file: {discipline}/{levelId}/{tableName}s.svg
    const svgPath = `${discipline}/${levelId}/${tableName}s.svg`;
    const svgContent = serializeToSvg(groupElements, viewBox);
    files.push({ path: svgPath, content: svgContent });

    // CSV file: {discipline}/{levelId}/{tableName}.csv
    const csvPath = `${discipline}/${levelId}/${tableName}.csv`;
    const csvContent = serializeToCsv(groupElements, tableName);
    files.push({ path: csvPath, content: csvContent });
  }

  if (files.length === 0) return;

  const resp = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });

  if (!resp.ok) {
    throw new Error(`Save failed: ${resp.status} ${resp.statusText}`);
  }
}
