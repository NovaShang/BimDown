import { readFileSync, writeFileSync } from 'node:fs';

export interface CsvData {
  headers: string[];
  rows: Record<string, string>[];
  /** Header names repeated in the file; merged into a single column. */
  duplicateHeaders?: string[];
}

export function readCsv(filePath: string): CsvData {
  let text = readFileSync(filePath, 'utf-8');
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };

  // A repeated header (e.g. two `id` columns written by older editors) is
  // merged into one column, first non-empty value winning, so callers always
  // see unique headers and DuckDB can create the table.
  const rawHeaders = parseCsvLine(lines[0]);
  const headers = [...new Set(rawHeaders)];
  const duplicateHeaders = headers.filter((h) => rawHeaders.indexOf(h) !== rawHeaders.lastIndexOf(h));
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < rawHeaders.length; i++) {
      if (!row[rawHeaders[i]]) row[rawHeaders[i]] = values[i] ?? '';
    }
    return row;
  });

  return duplicateHeaders.length > 0 ? { headers, rows, duplicateHeaders } : { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
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
