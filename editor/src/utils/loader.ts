import type { CsvRow, Level, FloorData, ProjectData, GridData, LayerData } from '../types.ts';
import { DISCIPLINE_TABLES, TABLE_TO_DISCIPLINE } from '../types.ts';
import type { DataSource } from './dataSource.ts';

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }
  return rows;
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

export async function loadProject(ds: DataSource): Promise<ProjectData> {
  let levels: Level[] = [];
  const text = await ds.fetchText('global/level.csv');
  if (text) {
    const rows = parseCsv(text);
    levels = rows.map(r => ({
      id: r.id,
      number: r.number || '',
      name: r.name || '',
      elevation: parseFloat(r.elevation) || 0,
    }));
  }

  levels.sort((a, b) => a.elevation - b.elevation);

  const floors = new Map<string, FloorData>();

  const fetchTasks: { disc: string; level: Level; tableName: string }[] = [];
  for (const [disc, tables] of Object.entries(DISCIPLINE_TABLES)) {
    for (const level of levels) {
      for (const tableName of tables) {
        fetchTasks.push({ disc, level, tableName });
      }
    }
  }

  const results = await Promise.all(
    fetchTasks.map(async ({ disc, level, tableName }) => {
      const [svgContent, csvContent] = await Promise.all([
        ds.fetchText(`${level.id}/${tableName}.svg`),
        ds.fetchText(`${level.id}/${tableName}.csv`),
      ]);
      return { disc, level, tableName, svgContent, csvContent };
    })
  );

  for (const { disc, level, tableName, svgContent, csvContent } of results) {
    if (!svgContent) continue;

    const csvMap = new Map<string, CsvRow>();
    if (csvContent) {
      for (const row of parseCsv(csvContent)) {
        if (row.id) csvMap.set(row.id, row);
      }
    }

    if (!floors.has(level.id)) {
      floors.set(level.id, {
        levelId: level.id,
        levelName: level.name || level.id,
        layers: [],
      });
    }

    floors.get(level.id)!.layers.push({
      tableName,
      discipline: disc,
      svgContent,
      csvRows: csvMap,
    });
  }

  return { levels, floors };
}

export async function loadGrids(ds: DataSource): Promise<GridData[]> {
  const text = await ds.fetchText('global/grid.csv');
  if (text) {
    const rows = parseCsv(text);
    return rows.map(r => ({
      id: r.id,
      number: r.number || '',
      x1: parseFloat(r.start_x) || 0,
      y1: parseFloat(r.start_y) || 0,
      x2: parseFloat(r.end_x) || 0,
      y2: parseFloat(r.end_y) || 0,
    }));
  }
  return [];
}

export async function loadLayer(ds: DataSource, levelId: string, tableName: string): Promise<LayerData | null> {
  const svgContent = await ds.fetchText(`${levelId}/${tableName}.svg`);
  if (!svgContent) return null;

  const csvContent = await ds.fetchText(`${levelId}/${tableName}.csv`);
  const csvMap = new Map<string, CsvRow>();
  if (csvContent) {
    const rows = parseCsv(csvContent);
    for (const row of rows) {
      if (row.id) csvMap.set(row.id, row);
    }
  }

  return {
    tableName,
    discipline: TABLE_TO_DISCIPLINE[tableName] ?? 'architectural',
    svgContent,
    csvRows: csvMap,
  };
}
