import type { DocumentState } from '../model/document.ts';
import { groupByLayer, serializeToSvg, serializeToCsv } from '../model/serialize.ts';

/**
 * Persist document state to disk via Vite middleware.
 * Serializes all layers to CSV + SVG and POSTs to /api/save.
 */
export async function persistDocument(doc: DocumentState, viewBox: string, model: string, changedKeys?: Set<string>): Promise<void> {
  const elements = Array.from(doc.elements.values());
  const groups = groupByLayer(elements);

  const keysToProcess = changedKeys ? new Set([...groups.keys(), ...changedKeys]) : new Set(groups.keys());

  const files: { path: string; content: string }[] = [];

  for (const key of keysToProcess) {
    if (changedKeys && !changedKeys.has(key)) continue;

    const groupElements = groups.get(key) || [];
    const [, tableName] = key.split('/');
    const levelId = doc.levelId;

    // SVG file: {levelId}/{tableName}s.svg
    const svgPath = `${levelId}/${tableName}s.svg`;
    const svgContent = serializeToSvg(groupElements, viewBox);
    files.push({ path: svgPath, content: svgContent });

    // CSV file: {levelId}/{tableName}.csv
    const csvPath = `${levelId}/${tableName}.csv`;
    const csvContent = serializeToCsv(groupElements, tableName);
    files.push({ path: csvPath, content: csvContent });
  }

  if (files.length === 0) return;

  const resp = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, files }),
  });

  if (!resp.ok) {
    throw new Error(`Save failed: ${resp.status} ${resp.statusText}`);
  }
}
