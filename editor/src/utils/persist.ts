import type { DocumentState } from '../model/document.ts';
import type { Level, GridData } from '../types.ts';
import { groupByLayer, serializeToSvg, serializeToCsv } from '../model/serialize.ts';
import type { DataSource } from './dataSource.ts';

/**
 * Persist document state via the data source.
 */
export async function persistDocument(doc: DocumentState, viewBox: string, ds: DataSource, changedKeys?: Set<string>): Promise<void> {
  // Grid elements are persisted to global/grid.csv separately, not per-level
  const elements = Array.from(doc.elements.values()).filter(e => e.tableName !== 'grid');
  const groups = groupByLayer(elements);

  const keysToProcess = changedKeys ? new Set([...groups.keys(), ...changedKeys]) : new Set(groups.keys());

  const saves: Promise<void>[] = [];

  for (const key of keysToProcess) {
    if (changedKeys && !changedKeys.has(key)) continue;

    const groupElements = groups.get(key) || [];
    const [, tableName] = key.split('/');
    const levelId = doc.levelId;

    const svgPath = `${levelId}/${tableName}s.svg`;
    const svgContent = serializeToSvg(groupElements, viewBox);
    saves.push(ds.saveFile(svgPath, svgContent));

    const csvPath = `${levelId}/${tableName}.csv`;
    const csvContent = serializeToCsv(groupElements, tableName);
    saves.push(ds.saveFile(csvPath, csvContent));
  }

  await Promise.all(saves);
}

export async function persistLevels(levels: Level[], ds: DataSource): Promise<void> {
  const header = 'id,number,name,elevation';
  const rows = levels.map(l => `${l.id},${l.number},${csvEscape(l.name)},${l.elevation}`);
  await ds.saveFile('global/level.csv', [header, ...rows].join('\n') + '\n');
}

export async function persistGrids(grids: GridData[], ds: DataSource): Promise<void> {
  const header = 'id,number,start_x,start_y,end_x,end_y';
  const rows = grids.map(g => `${g.id},${g.number},${g.x1},${g.y1},${g.x2},${g.y2}`);
  await ds.saveFile('global/grid.csv', [header, ...rows].join('\n') + '\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
