import type { CsvRow, Level, FloorData, ProjectData, GridData, LayerData } from '../types.ts';
import { DISCIPLINE_TABLES, TABLE_TO_DISCIPLINE } from '../types.ts';

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

async function fetchText(path: string): Promise<string | null> {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function loadProject(model: string): Promise<ProjectData> {
  const base = `/sample_data/${model}`;

  let levels: Level[] = [];
  const text = await fetchText(`${base}/global/level.csv`);
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

  // Build fetch tasks for all disciplines × tables × levels
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
      const levelDir = `${base}/${level.id}`;
      const [svgContent, csvContent] = await Promise.all([
        fetchText(`${levelDir}/${tableName}s.svg`),
        fetchText(`${levelDir}/${tableName}.csv`),
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


export async function loadGrids(model: string): Promise<GridData[]> {
  const text = await fetchText(`/sample_data/${model}/global/grid.csv`);
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

export async function loadLayer(model: string, levelId: string, tableName: string): Promise<LayerData | null> {
  const levelDir = `/sample_data/${model}/${levelId}`;
  const svgPath = `${levelDir}/${tableName}s.svg`;
  const csvPath = `${levelDir}/${tableName}.csv`;

  const svgContent = await fetchText(svgPath);
  if (!svgContent) return null;

  const csvContent = await fetchText(csvPath);
  const csvMap = new Map<string, CsvRow>();
  if (csvContent) {
    const rows = parseCsv(csvContent);
    for (const row of rows) {
      if (row.id) csvMap.set(row.id, row);
    }
  }

  return {
    tableName,
    discipline: TABLE_TO_DISCIPLINE[tableName] ?? 'architechture',
    svgContent,
    csvRows: csvMap,
  };
}
