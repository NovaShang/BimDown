import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsvText, type CsvData } from './csv-core.js';

export { parseCsvText, type CsvData };

export function readCsv(filePath: string): CsvData {
  return parseCsvText(readFileSync(filePath, 'utf-8'));
}

export function writeCsv(filePath: string, data: CsvData): void {
  const lines = [data.headers.join(',')];
  for (const row of data.rows) {
    const values = data.headers.map((h) => escapeCsvValue(row[h] ?? ''));
    lines.push(values.join(','));
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function escapeCsvValue(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}
